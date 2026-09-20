const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const portfolioRoot = path.join(projectRoot, 'docs', 'portfolio')

const requiredFiles = [
  'README.md',
  'architecture.md',
  'reproduce.md',
  'decisions-and-failures.md',
  'demo-script.md',
  'evidence-map.md',
  'resume-copy.md',
  'demo-data/README.md',
  'demo-data/xirang-demo-backup.json',
  'demo-data/focus-methods-demo.md',
  'diagrams/runtime-architecture/index.html',
  'diagrams/runtime-architecture/runtime-architecture.png',
  'diagrams/runtime-architecture/prompt.md',
  'diagrams/runtime-architecture/render-manifest.json',
]

const errors = []

function fail(message) {
  errors.push(message)
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(target) : [target]
  })
}

function relative(filePath) {
  return path.relative(projectRoot, filePath).replaceAll('\\', '/')
}

for (const required of requiredFiles) {
  const target = path.join(portfolioRoot, ...required.split('/'))
  if (!fs.existsSync(target)) fail(`缺少必需材料：docs/portfolio/${required}`)
}

if (fs.existsSync(portfolioRoot)) {
  const publicFiles = walk(portfolioRoot).filter((filePath) => /\.(?:md|json|html)$/i.test(filePath))
  const forbiddenPatterns = [
    { label: 'Windows 用户或桌面绝对路径', expression: /\b[A-Za-z]:\\(?:Users|desktop)\\/i },
    { label: '疑似明文 API Key', expression: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
    { label: '对话交接私有文件名', expression: /本次对话总结与下次对话前置参考资料/ },
  ]

  for (const filePath of publicFiles) {
    const contents = fs.readFileSync(filePath, 'utf8')
    for (const pattern of forbiddenPatterns) {
      if (pattern.expression.test(contents)) fail(`${relative(filePath)} 包含${pattern.label}`)
    }

    if (!filePath.endsWith('.md')) continue
    const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g
    for (const match of contents.matchAll(linkPattern)) {
      let target = match[1].trim()
      if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
      if (/^(?:https?:|mailto:|#)/i.test(target)) continue
      target = target.split('#')[0].split('?')[0]
      if (!target) continue
      let decoded
      try {
        decoded = decodeURIComponent(target)
      } catch {
        fail(`${relative(filePath)} 包含无法解码的链接：${target}`)
        continue
      }
      const resolved = path.resolve(path.dirname(filePath), decoded)
      if (!resolved.startsWith(projectRoot + path.sep)) {
        fail(`${relative(filePath)} 的链接越出仓库：${target}`)
      } else if (!fs.existsSync(resolved)) {
        fail(`${relative(filePath)} 的链接不存在：${target}`)
      }
    }
  }
}

const demoPath = path.join(portfolioRoot, 'demo-data', 'xirang-demo-backup.json')
if (fs.existsSync(demoPath)) {
  try {
    const demo = JSON.parse(fs.readFileSync(demoPath, 'utf8'))
    if (demo.product !== 'xirang' || demo.backupVersion !== 2 || demo.schemaVersion !== 11) {
      fail('合成备份不是当前 v11 / backupVersion 2 格式')
    }
    if (!demo.demoData || demo.demoData.synthetic !== true) {
      fail('合成备份缺少 demoData.synthetic=true 标记')
    }
    if (!Array.isArray(demo.state?.actionSlips) || demo.state.actionSlips.length < 2) {
      fail('合成备份至少需要 2 条行动便签')
    }
    if (!Array.isArray(demo.state?.focusSessions) || demo.state.focusSessions.length < 2) {
      fail('合成备份至少需要 2 条现实专注记录')
    }
  } catch (error) {
    fail(`合成备份 JSON 无效：${error.message}`)
  }
}

const diagramRoot = path.join(portfolioRoot, 'diagrams', 'runtime-architecture')
const diagramHtml = path.join(diagramRoot, 'index.html')
const diagramPng = path.join(diagramRoot, 'runtime-architecture.png')
const diagramPrompt = path.join(diagramRoot, 'prompt.md')
const diagramManifest = path.join(diagramRoot, 'render-manifest.json')

if ([diagramHtml, diagramPng, diagramPrompt, diagramManifest].every(fs.existsSync)) {
  const html = fs.readFileSync(diagramHtml)
  const htmlText = html.toString('utf8')
  const prompt = fs.readFileSync(diagramPrompt, 'utf8')
  const png = fs.readFileSync(diagramPng)
  let manifest = null
  try {
    manifest = JSON.parse(fs.readFileSync(diagramManifest, 'utf8'))
  } catch (error) {
    fail(`架构图渲染清单无效：${error.message}`)
  }
  const normalizedHtml = Buffer.from(htmlText.replaceAll('\r\n', '\n'), 'utf8')
  const sourceSha256 = crypto.createHash('sha256').update(normalizedHtml).digest('hex')
  if (manifest?.sourceSha256 !== sourceSha256) {
    fail('架构图 PNG 与 HTML 图源不同步，请运行 npm run portfolio:render-diagrams')
  }
  if ((manifest?.width ?? 0) < 2400 || (manifest?.height ?? 0) < 1200) {
    fail('架构图导出尺寸不足，宽度至少 2400px、高度至少 1200px')
  }
  if (!png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    fail('架构图文件不是有效 PNG')
  }
  for (const heading of ['## Must preserve', '## Suggested additions', '## Visual direction', '## Sister boundaries']) {
    if (!prompt.includes(heading)) fail(`架构图 prompt.md 缺少固定区块：${heading}`)
  }
  for (const forbidden of ['#fff', 'gradient', 'box-shadow', '<script', '<img']) {
    if (htmlText.toLowerCase().includes(forbidden)) fail(`架构图 HTML 包含禁止项：${forbidden}`)
  }
}

if (errors.length) {
  console.error(`Portfolio material check failed (${errors.length}):`)
  errors.forEach((error) => console.error(`- ${error}`))
  process.exitCode = 1
} else {
  console.log(`Portfolio material check passed (${requiredFiles.length} required files).`)
}
