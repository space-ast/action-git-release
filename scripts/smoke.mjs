// 只读冒烟脚本：拿真实平台响应去跑 provider 的归一化逻辑。
//
// 单测用的是手工构造的 fixture，只能证明「代码符合我理解的契约」；
// 这个脚本才能证明「我理解的契约符合平台的实际行为」。
// 它不做任何写操作，因此可以随时对公开仓库运行。
//
//   node scripts/smoke.mjs gitee
//   node scripts/smoke.mjs gitcode     # 需要 GITCODE_TOKEN，GitCode 匿名访问返回 403
//
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const TARGETS = {
  gitee: {
    apiBase: 'https://gitee.com/api/v5',
    webBase: 'https://gitee.com',
    // 公开仓库，匿名即可读
    owner: 'sdk',
    repo: 'gitee5j',
    tag: 'v1.0.0',
    entry: 'src/platform/gitee.ts',
    exportName: 'GiteeReleaser',
    tokenEnv: 'GITEE_TOKEN',
    tokenOptional: true,
  },
  gitcode: {
    apiBase: 'https://api.gitcode.com/api/v5',
    webBase: 'https://gitcode.com',
    owner: 'rust-learning',
    repo: 'serde',
    tag: 'v1.0.217',
    entry: 'src/platform/gitcode.ts',
    exportName: 'GitCodeReleaser',
    tokenEnv: 'GITCODE_TOKEN',
    tokenOptional: false,
  },
};

const checks = [];
const check = (label, condition, detail = '') => {
  checks.push({ label, ok: Boolean(condition), detail });
  console.log(`  ${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
};

/** 把 TS provider 打成临时 ESM，这样脚本跑的就是被测代码本身，而不是复制品。 */
const loadReleaser = async (target) => {
  const dir = mkdtempSync(join(tmpdir(), 'git-release-smoke-'));
  const outfile = join(dir, 'provider.mjs');
  await build({
    entryPoints: [target.entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    logLevel: 'error',
    // 依赖里 undici 是 CJS，打进 ESM 后它内部的 require 会变成 esbuild 的 __require
    // 兜底，那个兜底在没有真 require 的环境下直接抛
    // `Dynamic require of "node:assert" is not supported`。注入一个真 require 即可；
    // undici 动态 require 的都是 node 内置模块，所以按临时目录解析也没问题。
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });
  const mod = await import(pathToFileURL(outfile).href);
  rmSync(dir, { recursive: true, force: true });
  return mod[target.exportName];
};

const main = async () => {
  const name = process.argv[2] ?? 'gitee';
  const target = TARGETS[name];
  if (!target) {
    console.error(`Unknown target "${name}". Expected one of: ${Object.keys(TARGETS).join(', ')}`);
    process.exit(1);
  }

  const token = process.env[target.tokenEnv] ?? '';
  if (!token && !target.tokenOptional) {
    console.error(
      `${target.tokenEnv} is not set. ${name} rejects anonymous API access with 403, ` +
        'so this smoke test cannot run without a token.',
    );
    process.exit(2);
  }

  console.log(`\n🔎 ${name} smoke test against ${target.owner}/${target.repo}\n`);

  const Releaser = await loadReleaser(target);
  const releaser = new Releaser(target.apiBase, target.webBase, token);
  const ref = { owner: target.owner, repo: target.repo };

  const releases = await releaser.listReleases(ref);
  check('listReleases 返回数组', Array.isArray(releases), `${releases.length} 条`);

  const found = await releaser.getReleaseByTag({ ...ref, tag: target.tag });
  if (!found) {
    check(`getReleaseByTag(${target.tag}) 命中`, false, '该 tag 没有 release，换一个再试');
  } else {
    check(`getReleaseByTag(${target.tag}) 命中`, true);
    check('tagName 解析正确', found.tagName === target.tag, found.tagName);
    check('htmlUrl 已拼接', found.htmlUrl.startsWith(target.webBase), found.htmlUrl);
    check('id 非空', Boolean(found.id), found.id);
    check('prerelease 为布尔值', typeof found.prerelease === 'boolean', String(found.prerelease));
    check(
      'assets 只含上传的附件（自动源码包已排除）',
      Array.isArray(found.assets) && found.assets.every((a) => !a.downloadUrl.includes('/-/archive/')),
      `${found.assets.length} 个附件`,
    );
  }

  const missing = await releaser.getReleaseByTag({ ...ref, tag: 'definitely-not-a-real-tag-xyz' });
  check('查不到的 tag 返回 undefined 而不是抛错', missing === undefined);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ ${failed.length} 项失败`}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error('\n💥 冒烟测试异常：', error);
  process.exit(1);
});
