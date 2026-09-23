import { setFailed, setOutput } from '@actions/core';
import { env } from 'process';
import { basename } from 'path';
import { parseConfig, type Config } from './config';
import { createReleaser } from './platform';
import type { Asset, Release, Releaser, RepositoryRef } from './platform/types';
import { assetMatchesName, errorMessage, paths, releaseBody, unmatchedPatterns } from './util';

/** release 正文的长度上限（沿用 GitHub 的限制）。 */
const MAX_BODY_LENGTH = 125000;

export async function run(): Promise<void> {
  try {
    const config = parseConfig(env);
    const target = parseRepository(config.repository);
    const releaser = createReleaser(config);

    console.log(`🚀 Publishing to ${releaser.platform} (${config.repository})`);
    warnUnsupportedInputs(config, releaser);

    // 没有草稿能力的平台无法「先建草稿再补内容」，所以必须有明确的 tag 才能动手。
    const canDraft = releaser.capabilities.draft && config.input_draft === true;
    if (!config.tag_name && !canDraft) {
      throw new Error(
        '⚠️ Releases require a tag. Trigger the workflow from a tag, or set the tag_name input.',
      );
    }

    precheckFiles(config);

    const { release: created, created: wasCreated } = await release(config, releaser, target);
    let rel = created;

    if (config.input_files && config.input_files.length > 0) {
      rel = { ...rel, assets: await uploadAssets(config, releaser, target, rel) };
    }

    rel = await finalize(config, releaser, target, rel, wasCreated);

    report(rel);
  } catch (error: unknown) {
    setFailed(errorMessage(error));
  }
}

const parseRepository = (repository: string): RepositoryRef => {
  const [owner, repo, ...rest] = repository.split('/');
  if (!owner || !repo || rest.length > 0) {
    throw new Error(`⚠️ Invalid repository "${repository}". Expected <owner>/<repo>.`);
  }
  return { owner, repo };
};

/**
 * 平台不支持的能力一律「告警后继续」，而不是中断构建。
 * 迁移过来的 workflow 里往往还留着 GitHub 专用的输入，直接失败会让迁移寸步难行。
 */
const warnUnsupportedInputs = (config: Config, releaser: Releaser): void => {
  const { capabilities, platform } = releaser;
  const unsupported = (input: string): void => {
    console.warn(`⚠️ platform '${platform}' does not support \`${input}\`; ignoring.`);
  };

  if (config.input_draft === true && !capabilities.draft) {
    console.warn(
      `⚠️ platform '${platform}' does not support drafts; the release will be published immediately.`,
    );
  }
  if (config.input_generate_release_notes && !capabilities.generateReleaseNotes) {
    unsupported('generate_release_notes');
  }
  if (
    config.input_make_latest !== undefined &&
    config.input_make_latest !== 'legacy' &&
    !capabilities.makeLatest
  ) {
    unsupported('make_latest');
  }
  if (config.input_discussion_category_name && !capabilities.discussions) {
    unsupported('discussion_category_name');
  }
};

const precheckFiles = (config: Config): void => {
  if (!config.input_files) {
    return;
  }
  for (const pattern of unmatchedPatterns(config.input_files, config.input_working_directory)) {
    if (config.input_fail_on_unmatched_files) {
      throw new Error(`⚠️  Pattern '${pattern}' does not match any files.`);
    }
    console.warn(`🤔 Pattern '${pattern}' does not match any files.`);
  }
};

/**
 * 找到 tag 对应的 release 并创建或更新它。
 *
 * 创建失败时多一层兜底：并发 workflow（矩阵构建很常见）可能已经抢先建好了同一个 tag 的
 * release，此时回查一次改走更新，而不是让整个构建失败。
 */
const release = async (
  config: Config,
  releaser: Releaser,
  target: RepositoryRef,
): Promise<{ release: Release; created: boolean }> => {
  const tag = config.tag_name ?? '';
  const existing = await releaser.getReleaseByTag({ ...target, tag });

  if (existing) {
    return { release: await updateExisting(config, releaser, target, existing), created: false };
  }

  try {
    return { release: await createNew(config, releaser, target, tag), created: true };
  } catch (error: unknown) {
    // 矩阵构建下多个 job 会并发创建同一个 release，各平台给出的错误码并不统一
    // （GitHub 是 422 already_exists，Gitee/GitCode 未公开）。这里不猜错误码，
    // 而是直接回查一次：能查到就说明别人抢先建好了，改走更新即可；查不到说明是真失败。
    const raced = await releaser
      .getReleaseByTag({ ...target, tag })
      .catch((lookupError: unknown) => {
        console.warn(
          `⚠️ Could not check whether release ${tag} exists after a failed create: ${errorMessage(lookupError)}`,
        );
        return undefined;
      });

    if (!raced) {
      throw error;
    }

    console.warn(
      `⚠️ Creating release ${tag} failed (${errorMessage(error)}), but it already exists — ` +
        'most likely a concurrent matrix job created it. Updating it instead.',
    );
    return { release: await updateExisting(config, releaser, target, raced), created: false };
  }
};

const createNew = async (
  config: Config,
  releaser: Releaser,
  target: RepositoryRef,
  tag: string,
): Promise<Release> => {
  const targetCommitish = config.input_target_commitish;
  console.log(
    `👩🏭 Creating new release for tag ${tag}` +
      (targetCommitish ? ` using commit "${targetCommitish}"...` : '...'),
  );

  return releaser.createRelease({
    ...target,
    tagName: tag,
    name: config.input_name || tag,
    body: await resolveBody(config, releaser, {
      ...target,
      tag,
      targetCommitish,
      baseBody: releaseBody(config) ?? '',
    }),
    draft: config.input_draft,
    prerelease: config.input_prerelease,
    targetCommitish,
    makeLatest: config.input_make_latest,
  });
};

const updateExisting = async (
  config: Config,
  releaser: Releaser,
  target: RepositoryRef,
  existing: Release,
): Promise<Release> => {
  console.log(`Found existing release ${existing.name || existing.tagName} (id=${existing.id})`);

  const targetCommitish =
    config.input_target_commitish && config.input_target_commitish !== existing.targetCommitish
      ? config.input_target_commitish
      : existing.targetCommitish;

  const workflowBody = releaseBody(config) ?? '';
  const baseBody =
    config.input_append_body && workflowBody && existing.body
      ? `${existing.body}\n${workflowBody}`
      : workflowBody || existing.body;

  return releaser.updateRelease({
    ...target,
    release: existing,
    tagName: existing.tagName,
    name: config.input_name || existing.name || existing.tagName,
    body: await resolveBody(config, releaser, {
      ...target,
      tag: existing.tagName,
      targetCommitish,
      baseBody,
    }),
    draft: config.input_draft,
    prerelease:
      config.input_prerelease !== undefined ? config.input_prerelease : existing.prerelease,
    targetCommitish,
    makeLatest: config.input_make_latest,
  });
};

/** 生成 release notes 并拼接正文；平台不支持时已经告警过，这里直接用原始正文。 */
const resolveBody = async (
  config: Config,
  releaser: Releaser,
  context: RepositoryRef & {
    tag: string;
    targetCommitish: string | undefined;
    baseBody: string;
  },
): Promise<string> => {
  let body = context.baseBody;

  if (config.input_generate_release_notes && releaser.generateReleaseNotes) {
    console.log('📝 Generating release notes...');
    const notes = await releaser.generateReleaseNotes({
      owner: context.owner,
      repo: context.repo,
      tagName: context.tag,
      targetCommitish: context.targetCommitish,
      previousTag: config.input_previous_tag,
    });
    if (notes.body) {
      // 用户手写的正文在前，自动生成的在后——与上游一致。
      body = body ? `${body}\n\n${notes.body}` : notes.body;
    }
  }

  return body.substring(0, MAX_BODY_LENGTH - 1);
};

/**
 * 上传 `files` 匹配到的附件，返回上传后（重新查询得到的）附件列表。
 *
 * 覆盖写沿用上游语义：同名附件在 `overwrite_files` 非 false 时先删后传。
 */
const uploadAssets = async (
  config: Config,
  releaser: Releaser,
  target: RepositoryRef,
  rel: Release,
): Promise<Asset[]> => {
  const files = paths(config.input_files ?? [], config.input_working_directory);
  if (files.length === 0) {
    if (config.input_fail_on_unmatched_files) {
      throw new Error(`⚠️ ${config.input_files} does not include a valid file.`);
    }
    console.warn(`🤔 ${config.input_files} does not include a valid file.`);
    return rel.assets;
  }

  // 本地维护一份「当前已存在的附件」，删掉一个就抹掉一条，避免同名文件被重复删除。
  const known = new Map<string, Asset>(
    (await releaser.listReleaseAssets({ ...target, release: rel })).map((asset) => [
      asset.name,
      asset,
    ]),
  );
  const uploaded = new Set<string>();

  const uploadFile = async (path: string): Promise<void> => {
    const name = basename(path);
    const existing = findAsset(known, name);

    if (existing) {
      if (config.input_overwrite_files === false) {
        console.log(`Asset ${name} already exists and overwrite_files is false...`);
        return;
      }
      console.log(`♻️ Deleting previously uploaded asset ${name}...`);
      await releaser.deleteReleaseAsset({ ...target, release: rel, assetId: existing.id });
      known.delete(existing.name);
    }

    console.log(`⬆️ Uploading ${name}...`);
    const asset = await releaser.uploadReleaseAsset({ ...target, release: rel, path });
    console.log(`✅ Uploaded ${name}`);
    known.set(asset.name, asset);
    uploaded.add(asset.id);
  };

  if (config.input_preserve_order) {
    for (const path of files) {
      await uploadFile(path);
    }
  } else {
    await Promise.all(files.map(uploadFile));
  }

  if (uploaded.size === 0) {
    return [];
  }

  // 重新查询一遍，拿到平台最终确定的下载地址与体积。
  const finalAssets = await releaser.listReleaseAssets({ ...target, release: rel });
  return finalAssets.filter((asset) => uploaded.has(asset.id));
};

const findAsset = (known: Map<string, Asset>, name: string): Asset | undefined => {
  for (const asset of known.values()) {
    if (assetMatchesName(name, asset)) {
      return asset;
    }
  }
  return undefined;
};

/**
 * 发布草稿 release。只有支持草稿的平台需要这一步；
 * 用户显式要求保留草稿（`draft: true`）时同样跳过。
 */
const finalize = async (
  config: Config,
  releaser: Releaser,
  target: RepositoryRef,
  rel: Release,
  wasCreated: boolean,
): Promise<Release> => {
  if (config.input_draft === true || !rel.draft || !releaser.finalizeRelease) {
    return rel;
  }

  console.log('Finalizing release...');
  try {
    return await releaser.finalizeRelease({
      ...target,
      release: rel,
      makeLatest: config.input_make_latest,
    });
  } catch (error: unknown) {
    if (!wasCreated) {
      // 本来就存在的草稿，发布失败就原样留着，重跑一次还能接着用。
      throw error;
    }
    const reason = errorMessage(error);
    console.warn(`⚠️ Failed to publish draft release: ${reason}`);
    const cleaned = await deleteQuietly(releaser, target, rel);
    throw new Error(
      `⚠️ Could not publish release ${rel.tagName}: ${reason}. ` +
        (cleaned
          ? 'The draft was deleted to avoid leaving it behind.'
          : 'The orphaned draft could not be deleted; remove it manually.'),
    );
  }
};

const deleteQuietly = async (
  releaser: Releaser,
  target: RepositoryRef,
  rel: Release,
): Promise<boolean> => {
  try {
    await releaser.deleteRelease({ ...target, release: rel });
    return true;
  } catch (error: unknown) {
    console.warn(`⚠️ Could not delete orphaned draft ${rel.id}: ${errorMessage(error)}`);
    return false;
  }
};

const report = (rel: Release): void => {
  // 输出形状与上游一致，`fromJSON(...).browser_download_url` 这种既有写法可以照用不误。
  setOutput(
    'assets',
    rel.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      ...(asset.size !== undefined ? { size: asset.size } : {}),
      browser_download_url: asset.downloadUrl,
    })),
  );
  setOutput('url', rel.htmlUrl);
  setOutput('id', rel.id);
  setOutput('upload_url', rel.uploadUrl);
  console.log(`🎉 Release ready at ${rel.htmlUrl}`);
};
