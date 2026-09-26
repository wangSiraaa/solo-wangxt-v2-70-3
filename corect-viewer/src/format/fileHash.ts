/**
 * 文件内容身份指纹：SHA-256（十六进制）。
 * 刷新恢复双体积会话时重算并与会话保存的指纹比对——
 * 两份原文件内容均一致才恢复旧映射，任一文件内容变化则停用映射并要求重新确认。
 */
export async function computeFileHash(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}
