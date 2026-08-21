"use strict";
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const PYTHON_RESOURCES_MARKER = "/resources/python/";

/**
 * electron-builder 自定义 Windows 签名函数（win.signtoolOptions.sign）。
 * 由 WindowsSignToolManager.signFile 调用，签名 (configuration, packager)。
 * - 命中 resources\\python（内置 python 3.14.6）路径时直接跳过，不调用 signtool；
 * - 其余文件按 electron-builder 默认参数执行 signtool 签名。
 */
exports.sign = async function sign(configuration, packager) {
  const filePath = configuration.path;
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.includes(PYTHON_RESOURCES_MARKER)) {
    console.log(`[sign] skip (inside resources/python): ${filePath}`);
    return true;
  }
  const args = configuration.computeSignToolArgs(true);
  const signingManager = await packager.signingManager.value;
  const toolInfo = await signingManager.getToolPath(true);
  console.log(`[sign] ${toolInfo.path} ${args.join(" ")}`);
  await execFileAsync(toolInfo.path, args, {
    env: { ...process.env, ...(toolInfo.env || {}) },
    timeout: parseInt(process.env.SIGNTOOL_TIMEOUT, 10) || 10 * 60 * 1000,
  });
  return true;
};
