import { net, session } from 'electron'
import { createWriteStream } from 'fs'

export async function downloadFile(
  url: string,
  filePath: string,
  progressCallback?: (percent: number) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = net.request({
      url,
      session: session.defaultSession // 显式指定使用 defaultSession（确保代理配置生效）
    })

    // 禁用缓存的请求头（确保每次都下载最新文件）
    request.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    request.setHeader('Pragma', 'no-cache')
    request.setHeader('Expires', '0')

    request.setHeader(
      'accept',
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'
    )
    request.setHeader('accept-encoding', 'gzip, deflate, br, zstd')
    request.setHeader('accept-language', 'zh-CN,zh;q=0.9')
    request.setHeader('priority', 'u=0, i')
    request.setHeader(
      'sec-ch-ua',
      '"Chromium";v="142", "Microsoft Edge";v="142", "Not_A Brand";v="99"'
    )
    request.setHeader('sec-ch-ua-mobile', '?0')
    request.setHeader('sec-ch-ua-platform', '"macOS"')
    request.setHeader('sec-fetch-dest', 'document')
    request.setHeader('sec-fetch-mode', 'navigate')
    request.setHeader('sec-fetch-site', 'none')
    request.setHeader('sec-fetch-user', '?1')
    request.setHeader('upgrade-insecure-requests', '1')
    request.setHeader(
      'user-agent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0'
    )
    // 🔥新增：进度统计变量
    let receivedBytes = 0
    let totalBytes = 0
    let lastPercent = -1
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`下载失败: HTTP ${response.statusCode}`))
        return
      }

      // 获取文件总大小
      totalBytes = parseInt(response.headers['content-length'] as string) || 0
      console.log(`\n📥 开始下载：${url}`)
      console.log(`📦 文件大小：${(totalBytes / 1024 / 1024).toFixed(2)} MB`)

      // ==============================================
      // 🔥 改用流式写入（支持大文件，不爆内存）
      // ==============================================
      const writeStream = createWriteStream(filePath)
      // const chunks: Buffer[] = []
      response.on('data', (chunk) => {
        writeStream.write(chunk)
        receivedBytes += chunk.length

        if (totalBytes > 0) {
          //传递进度状态
          if (progressCallback) {
            const percent = Math.floor((receivedBytes / totalBytes) * 100)
            if (percent !== lastPercent && percent % 2 === 0) {
              // 每2%打印一次，避免刷屏
              lastPercent = percent
              console.log(
                `✅ 下载进度：${percent}% (${(receivedBytes / 1024 / 1024).toFixed(2)}MB / ${(totalBytes / 1024 / 1024).toFixed(2)}MB)`
              )
            }
            progressCallback(percent)
          }
        }
      })

      response.on('end', async () => {
        try {
          writeStream.end()
          console.log(`\n✅ 下载完成！保存到：${filePath}`)
          resolve()
        } catch (err) {
          reject(err)
        }
      })

      response.on('error', (err) => {
        reject(err)
      })
    })

    request.on('error', (err) => {
      reject(err)
    })

    request.end()
  })
}
