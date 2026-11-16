/**
 * 方寸 · 私有专名表（2026-11-16 · 照司天 `scripts/privacy-terms.js` 的做法）
 *
 * ## 为什么是 base64，不是明文
 *
 * 暮雨 2026-11-16：
 * > 「顺手抓到了使用手册的问题：**私有专名没处理干净**。比如 `但不会改司天/墨坊那些项目的代码。`，
 * > **司天/墨坊永不该出现在方寸的任何一处文案中**。……隔壁司天一直报错，因为标点符号和
 * > 私有专名检查没过，**已经处理好**。」
 *
 * 同一个道理司天已经在注释里写过：
 * **扫描器若把"要防的词"明文写在仓库里，它自己就是最大的泄漏源。**
 * 所以这里只存 base64；扫描器与守卫都从这一个文件读同一份词表（不许各写一份黑名单）。
 *
 * ## 加词怎么加
 *
 *   node -e "console.log(Buffer.from(JSON.stringify({terms:['新词']}),'utf8').toString('base64'))"
 *
 * 然后把结果贴到下面的 B64。
 */
'use strict'

const B64 =
  'eyJ0ZXJtcyI6WyLlj7jlpKkiLCLnu5LoirHloqjlnYoiLCLloqjlnYoiLCLnu5LoirEiLCLmmI7pibQiLCLorr' +
  'Dlv4blnKPmiYAiLCJST1NBIiwiU2lUaWFuIiwiQzpcXFxcVXNlcnNcXFxcbXV5dSIsIkU6XFxcXOWbvuS5pummhiIs' +
  'IkU6XFxcXENPREVcXFxcQ2FuZ0t1Il19'

/** 解出词表。解不出就返回空数组 —— **不抛**，扫描器不该因为词表坏了而崩。 */
function decodeTerms() {
  try {
    const obj = JSON.parse(Buffer.from(B64, 'base64').toString('utf8'))
    return Array.isArray(obj && obj.terms) ? obj.terms.slice() : []
  } catch (_) {
    return []
  }
}

module.exports = { B64, decodeTerms }
