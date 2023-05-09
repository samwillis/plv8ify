import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import task from 'tasuku'
import { match } from 'ts-pattern'

import { Database } from '../helpers/Database'
import { ParseCLI } from '../helpers/ParseCLI'

dotenv.config()

// File name/function name are configurable but with the same variable, so they will always match (so far)
function getFunctionNameFromFilePath(filePath: string) {
  const fileName = path.basename(filePath, '.plv8.sql')
  return fileName
}

export async function deployCommand(
  CLI: ReturnType<typeof ParseCLI.getCommand>
) {
  const outputFolderPath = CLI.config.outputFolderPath

  const checkOutputFolderTask = await task(
    `Check if the --output-folder (${outputFolderPath}) exists`,
    async ({ setError }) => {
      if (!fs.statSync(outputFolderPath)) {
        const errorMessage = `${outputFolderPath} doesn't exist`
        setError(errorMessage)
      }
    }
  )
  if (checkOutputFolderTask.state === 'error') {
    ParseCLI.throwError()
  }

  // TODO: move process/env stuff to a separate file
  const databaseUrl = process.env.DATABASE_URL

  const databaseUrlIsSetTask = await task(
    'Check if the DATABASE_URL env var is set',
    async ({ setError }) => {
      if (!databaseUrl) {
        const errorMessage = `DATABASE_URL not set in environment`
        setError(errorMessage)
      }
    }
  )
  if (databaseUrlIsSetTask.state === 'error') {
    ParseCLI.throwError()
  }

  const database = new Database(databaseUrl)
  const isDatabaseReachableTask = await task(
    'Check if the provided DATABASE_URL is reachable',
    async ({ setError }) => {
      const isReachable = await database.isDatabaseReachable()
      if (!isReachable) {
        const errorMessage = `Provided DATABASE_URL: ${databaseUrl} is not reachable`
        setError(errorMessage)
      }
    }
  )
  if (isDatabaseReachableTask.state === 'error') {
    ParseCLI.throwError()
  }

  const db = database.getConnection()

  await match(CLI.config.deployMode)
    .with('functions', async () => {
      const deployCommands = fs
        .readdirSync(outputFolderPath)
        // Only extract .plv8.sql files, this will need to change if we ever make the extension configurable
        .filter((file) => file.endsWith('.plv8.sql'))
        .map((file) => {
          const filePath = path.join(outputFolderPath, file)
          return {
            filePath,
            sqlQueryPromise: db.file(filePath),
          }
        })

      await task(
        `Deploying files from ${outputFolderPath} to the provided PostgreSQL database 🚧`.trim(),
        async ({ setWarning }) => {
          const taskGroup = await task.group((task) =>
            deployCommands.map((deployCommand) => {
              const name = getFunctionNameFromFilePath(deployCommand.filePath)
              return task(
                `Deploying ${name}`,
                async ({ setTitle: _setTitle, setError: _setError }) => {
                  try {
                    await deployCommand.sqlQueryPromise
                    _setTitle(`Deployed ${name}`)
                  } catch (e) {
                    _setError(
                      `Failed to deploy ${name} (because of ${e.message})`
                    )
                    setWarning(`Failed to some functions (see below))`)
                  }
                }
              )
            })
          )

          // TODO: add some batching here
          await Promise.allSettled(taskGroup)
        }
      )
    })
    .with('pg_tle', async () => {
      const deployableFunctionsSQL = fs
        .readdirSync(outputFolderPath)
        // Only extract .plv8.sql files, this will need to change if we ever make the extension configurable
        .filter((file) => file.endsWith('.plv8.sql'))
        .map((file) => {
          const filePath = path.join(outputFolderPath, file)
          const fileContents = fs.readFileSync(filePath, 'utf-8')
          return fileContents
        })
        .join('\n')
      await task(
        `Deploying files from ${outputFolderPath} to the provided PostgreSQL database as a pg_tle extension 🚧`.trim(),
        async ({ setTitle, setError }) => {
          try {
            const extensionName = CLI.config.pgTLEExtensionName
            const extensionVersion = CLI.config.pgTLEExtensionVersion
            const extensionDescription = CLI.config.pgTLEExtensionDescription
            await db.begin(async (db) => {
              await db`CREATE EXTENSION IF NOT EXISTS pg_tle`
              await db`DROP EXTENSION IF EXISTS ${db(extensionName)}`
              await db`SELECT pgtle.uninstall_extension_if_exists(${extensionName})`
              await db`SELECT pgtle.install_extension(
                ${extensionName},
                ${extensionVersion},
                ${extensionDescription},
                ${deployableFunctionsSQL}
              )`
              await db`CREATE EXTENSION IF NOT EXISTS ${db(extensionName)}`
            })
            await db.listen('notices', (payload) => {
              console.log({ payload })
            })
            setTitle(
              `Deployed files from ${outputFolderPath} to the provided PostgreSQL database as a pg_tle extension ✅`
            )
          } catch (e) {
            setError(
              'Failed to deploy the functions in the provided output folder as a pg_tle extension because: ' +
                e
            )
          }
        }
      )
    })
    .exhaustive()

  database.endConnection()
}