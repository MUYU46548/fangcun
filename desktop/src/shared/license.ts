/**
 * 许可协议总闸的**共享常量**（2026-11-18）。
 *
 * 为什么单独放 shared：
 *   · 主进程的闸（`main/license.ts`）与渲染层的弹窗（`renderer/disclaimer.ts`）必须认同一版；
 *   · 版本号只改这一处；正文改了就抬版本并重算指纹（`desktop/test/license-gate.cjs` 守着）。
 *
 * `LICENSE_CONTENT_SHA` = `renderer/disclaimer.ts` 里
 * `=== LICENSE-CONTENT-BEGIN ===` 与 `=== LICENSE-CONTENT-END ===` 之间文本的
 * SHA-256 前 12 位（LF 归一后）。它证明“用户同意的是这一版正文”，不靠客户端自称。
 */
export const LICENSE_VERSION = '1.5'
export const LICENSE_CONTENT_SHA = '093a06f44a6c'
