// 用途：构建快照和拆包验收共享同一运行依赖清单，禁止缺件静默降级。
import fs from 'node:fs';
import path from 'node:path';

export const HOOK_FILES = Object.freeze([
 'build_index.js', 'skill_filter.js', 'context_monitor.js', 'prefix_canon.js',
 'compact_fold.js', 'text_parts.js', 'tool_compress.js', 'source_sidecar.js',
 'session_context.js', 'session_state.js', 'store_persist.js', 'event_log.js', 'index_evidence.js',
 'request_catalog.js',
]);

/** 只检查文件与静态相对依赖，不执行来源模块。 */
export function validateHookDirectory(dir) {
 const problems = [];
 for (const name of HOOK_FILES) {
  const file = path.join(dir, name);
  try {
   const stat = fs.lstatSync(file);
   if (!stat.isFile() || stat.size === 0) {
    problems.push(`无效钩子模块：${name}（必须为非空普通文件）`);
    continue;
   }
   const source = fs.readFileSync(file, 'utf8');
   for (const match of source.matchAll(/\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    const target = path.posix.normalize(match[1]);
    const dependency = target.endsWith('.js') ? target : target + '.js';
    if (!HOOK_FILES.includes(dependency)) problems.push(`未登记运行依赖：${name} → ${match[1]}（须纳入钩子清单）`);
   }
  } catch {
   problems.push(`缺少或无法读取钩子模块：${name}`);
  }
 }
 return problems;
}
