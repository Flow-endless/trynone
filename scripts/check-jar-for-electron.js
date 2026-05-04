/**
 * 供 desktop 打包前校验：必须先 mvn package 生成 JAR。
 */
const fs = require('fs')
const path = require('path')

const jar = path.join(__dirname, '..', 'target', 'deepseek-0.0.1-SNAPSHOT.jar')
if (!fs.existsSync(jar)) {
  console.error('[electron-build] 未找到 JAR，请先在项目根目录执行: mvn package -DskipTests')
  console.error('  期望文件:', jar)
  process.exit(1)
}
