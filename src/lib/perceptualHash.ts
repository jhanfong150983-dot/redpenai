/**
 * perceptualHash.ts
 *
 * 計算照片的感知雜湊（dHash），用於偵測學生是否拍了重複照片。
 *
 * dHash 原理：
 * 1. 縮圖到 9×8 灰階
 * 2. 比對相鄰像素（左 vs 右），左 > 右 則該位元為 1，否則 0
 * 3. 共 8×8 = 64 bit
 *
 * 兩張照片 hash 的 Hamming distance:
 *   - 同一張照片拍兩次：通常 < 5
 *   - 不同頁：通常 > 15
 */

const HASH_WIDTH = 9   // 比對相鄰像素，需要 9 列
const HASH_HEIGHT = 8

/**
 * 計算照片的 dHash，回傳 64-bit hash 的 hex 字串（16 字元）。
 */
export async function computePerceptualHash(blob: Blob): Promise<string> {
  const img = await loadImage(blob)
  const canvas = document.createElement('canvas')
  canvas.width = HASH_WIDTH
  canvas.height = HASH_HEIGHT
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!

  // 縮圖到 9×8（Canvas 內建雙線性插值）
  ctx.drawImage(img, 0, 0, HASH_WIDTH, HASH_HEIGHT)
  const imageData = ctx.getImageData(0, 0, HASH_WIDTH, HASH_HEIGHT)
  const data = imageData.data

  // 轉灰階（亮度公式）
  const gray = new Array<number>(HASH_WIDTH * HASH_HEIGHT)
  for (let i = 0; i < HASH_WIDTH * HASH_HEIGHT; i++) {
    const r = data[i * 4]
    const g = data[i * 4 + 1]
    const b = data[i * 4 + 2]
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b
  }

  // 比對相鄰像素，組成 64-bit hash
  let bits = ''
  for (let y = 0; y < HASH_HEIGHT; y++) {
    for (let x = 0; x < HASH_WIDTH - 1; x++) {
      const left = gray[y * HASH_WIDTH + x]
      const right = gray[y * HASH_WIDTH + x + 1]
      bits += left > right ? '1' : '0'
    }
  }

  // 轉成 hex 字串（16 字元）
  let hex = ''
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  }
  return hex
}

/**
 * 計算兩個 hash 字串的 Hamming distance（不同位元數）。
 */
export function hammingDistance(hashA: string, hashB: string): number {
  if (hashA.length !== hashB.length) {
    throw new Error(`hash length mismatch: ${hashA.length} vs ${hashB.length}`)
  }
  let distance = 0
  for (let i = 0; i < hashA.length; i++) {
    const a = parseInt(hashA[i], 16)
    const b = parseInt(hashB[i], 16)
    let xor = a ^ b
    while (xor > 0) {
      distance += xor & 1
      xor >>= 1
    }
  }
  return distance
}

async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = (err) => {
      URL.revokeObjectURL(url)
      reject(err)
    }
    img.src = url
  })
}
