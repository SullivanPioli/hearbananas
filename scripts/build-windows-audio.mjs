import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  throw new Error('The filtered-audio helper must be compiled on Windows')
}

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const sourceDirectory = join(repositoryRoot, 'native', 'windows-system-audio')
const buildDirectory = join(sourceDirectory, 'build')
const compiledHelper = join(buildDirectory, 'Release', 'hearbananas-system-audio.exe')
const packagedHelper = join(
  repositoryRoot,
  'resources',
  'bin',
  'win32-x64',
  'hearbananas-system-audio.exe'
)

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: repositoryRoot, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status ?? 'unknown'}`)
  }
}

run('cmake', ['-S', sourceDirectory, '-B', buildDirectory, '-A', 'x64'])
run('cmake', ['--build', buildDirectory, '--config', 'Release'])
mkdirSync(dirname(packagedHelper), { recursive: true })
copyFileSync(compiledHelper, packagedHelper)
console.log(`Prepared ${packagedHelper}`)
