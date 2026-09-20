const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')

const projectRoot = path.resolve(__dirname, '..')
const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)

const browserPath = chromeCandidates.find((candidate) => fs.existsSync(candidate))
if (!browserPath) {
  console.error('未找到 Chrome 或 Edge。可通过 CHROME_PATH 指定 Chromium 浏览器。')
  process.exit(1)
}

const diagrams = [{
  source: path.join(projectRoot, 'docs', 'portfolio', 'diagrams', 'runtime-architecture', 'index.html'),
  output: path.join(projectRoot, 'docs', 'portfolio', 'diagrams', 'runtime-architecture', 'runtime-architecture.png'),
  manifest: path.join(projectRoot, 'docs', 'portfolio', 'diagrams', 'runtime-architecture', 'render-manifest.json'),
  width: 1440,
  height: 820,
}]

function pngSize(filePath) {
  const buffer = fs.readFileSync(filePath)
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buffer.subarray(0, 8).equals(signature) || buffer.length < 24) {
    throw new Error(`${filePath} 不是有效 PNG。`)
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function renderDiagram(diagram) {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xirang-portfolio-render-'))
  try {
    const result = spawnSync(browserPath, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profileRoot}`,
      '--force-device-scale-factor=2',
      `--window-size=${diagram.width},${diagram.height}`,
      `--screenshot=${diagram.output}`,
      pathToFileURL(diagram.source).href,
    ], { encoding: 'utf8', windowsHide: true })
    if (result.status !== 0 || !fs.existsSync(diagram.output)) {
      throw new Error(result.stderr || result.stdout || `浏览器退出码 ${result.status}`)
    }
    const size = pngSize(diagram.output)
    const source = Buffer.from(fs.readFileSync(diagram.source, 'utf8').replaceAll('\r\n', '\n'), 'utf8')
    fs.writeFileSync(diagram.manifest, `${JSON.stringify({
      source: path.basename(diagram.source),
      output: path.basename(diagram.output),
      sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
      width: size.width,
      height: size.height,
      renderer: path.basename(browserPath),
    }, null, 2)}\n`)
    console.log(`Rendered ${path.relative(process.cwd(), diagram.output)} (${size.width}x${size.height}).`)
  } finally {
    const resolvedTempRoot = path.resolve(os.tmpdir())
    const resolvedProfileRoot = path.resolve(profileRoot)
    const isOwnedTempProfile = resolvedProfileRoot.startsWith(`${resolvedTempRoot}${path.sep}`)
      && path.basename(resolvedProfileRoot).startsWith('xirang-portfolio-render-')
    if (!isOwnedTempProfile) throw new Error(`拒绝清理非预期目录：${resolvedProfileRoot}`)
    fs.rmSync(resolvedProfileRoot, { recursive: true, force: true })
  }
}

for (const diagram of diagrams) renderDiagram(diagram)
