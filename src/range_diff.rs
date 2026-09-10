use std::{path::Path, process::Stdio, time::Duration};

use anyhow::{Context, anyhow, bail};
use tokio::{io::AsyncReadExt, process::Command, time};

use crate::{GitRangeDiffRef, GitRangeDiffResult};

const TIMEOUT: Duration = Duration::from_secs(15);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(12);
const OUTPUT_LIMIT: usize = 256_000;
const COMMIT_LIMIT: usize = 256;
const PATCH_INPUT_LIMIT: usize = 8_000_000;

// range-diff starts git-log children. Killing only the parent leaves those running.
#[cfg(unix)]
struct ProcessGroup(Option<u32>);

#[cfg(unix)]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        // The unreaped leader reserves this group ID until capture disarms us.
        if let Some(pid) = self.0 {
            unsafe {
                kill(-(pid as i32), 9);
            }
        }
    }
}

fn git_command(repo: &Path) -> Command {
    let mut command = Command::new("git");
    // Inherited GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_*, GIT_EXEC_PATH, etc. must
    // neither redirect the selected repository nor inject nested Git behavior.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
        .current_dir(repo)
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_ALLOW_PROTOCOL", "")
        .env("GIT_TERMINAL_PROMPT", "0")
        .args([
            "--no-pager",
            "--no-replace-objects",
            "--no-lazy-fetch",
            "--no-optional-locks",
            "--literal-pathspecs",
        ])
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.pager=cat",
            "-c",
            "pager.log=false",
            "-c",
            "pager.range-diff=false",
            "-c",
            "log.showSignature=false",
            "-c",
            "maintenance.auto=false",
            "-c",
            "gc.auto=0",
            "-c",
            "protocol.allow=never",
            "-c",
            "credential.helper=",
            "-c",
            "diff.external=",
            "-c",
            "diff.submodule=short",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    command
}

async fn capture(
    mut command: Command,
    args: &[&str],
    limit: usize,
) -> anyhow::Result<(String, bool)> {
    let mut child = command
        .args(args)
        .spawn()
        .context("Could not run installed Git")?;
    #[cfg(unix)]
    let mut group = ProcessGroup(Some(
        child.id().ok_or_else(|| anyhow!("Git process has no ID"))?,
    ));
    let mut stdout = child
        .stdout
        .take()
        .context("Could not capture Git stdout")?;
    let mut stderr = child
        .stderr
        .take()
        .context("Could not capture Git stderr")?;
    let read_stdout = async {
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 8192];
        let mut truncated = false;
        loop {
            let count = stdout.read(&mut chunk).await?;
            if count == 0 {
                break;
            }
            let remaining = limit.saturating_sub(bytes.len());
            bytes.extend_from_slice(&chunk[..count.min(remaining)]);
            truncated |= count > remaining;
        }
        Ok::<_, std::io::Error>((bytes, truncated))
    };
    let read_stderr = async {
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 8192];
        loop {
            let count = stderr.read(&mut chunk).await?;
            if count == 0 {
                break;
            }
            let remaining = 65_536_usize.saturating_sub(bytes.len());
            bytes.extend_from_slice(&chunk[..count.min(remaining)]);
        }
        Ok::<_, std::io::Error>(bytes)
    };
    let (status, (bytes, truncated), stderr) = time::timeout(COMMAND_TIMEOUT, async {
        // Nested Git processes inherit the pipes. Drain them before reaping the
        // leader, so cancellation cannot signal a recycled process-group ID.
        let (stdout, stderr) = tokio::try_join!(read_stdout, read_stderr)?;
        let status = child.wait().await?;
        #[cfg(unix)]
        {
            group.0 = None;
        }
        Ok::<_, std::io::Error>((status, stdout, stderr))
    })
    .await
    .context("Git range-diff subprocess timed out")??;
    if !status.success() {
        bail!(
            "Git {} failed (range-diff requires Git with --no-lazy-fetch support): {}",
            args.first().unwrap_or(&"command"),
            String::from_utf8_lossy(&stderr).trim()
        );
    }
    // Never insert synthetic text into native output. Invalid UTF-8 is explicit,
    // except an incomplete final code point cut by the byte cap.
    let mut bytes = bytes;
    if let Err(error) = std::str::from_utf8(&bytes) {
        if truncated && error.error_len().is_none() {
            bytes.truncate(error.valid_up_to());
        } else {
            bail!("Git range-diff output is not valid UTF-8");
        }
    }
    Ok((String::from_utf8(bytes)?, truncated))
}

async fn git(repo: &Path, args: &[&str], limit: usize) -> anyhow::Result<String> {
    let (text, truncated) = capture(git_command(repo), args, limit).await?;
    if truncated {
        bail!("Git range-diff input exceeds the {limit}-byte limit");
    }
    Ok(text)
}

async fn resolve(repo: &Path, label: &str, input: &str) -> anyhow::Result<GitRangeDiffRef> {
    if input.trim().is_empty() {
        bail!("{label} ref must not be empty");
    }
    if input.len() > 4096 || input.contains('\0') {
        bail!("{label} ref is invalid or too long");
    }
    let rev = format!("{input}^{{commit}}");
    let oid = git(repo, &["rev-parse", "--verify", "--end-of-options", &rev], 1024)
        .await.with_context(|| format!("Could not resolve {label} ref {input:?} to a commit (check the ref or configured upstream)"))?;
    let oid = oid.trim();
    if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("{label} ref did not resolve to one full commit object ID");
    }
    Ok(GitRangeDiffRef {
        input: input.to_owned(),
        oid: oid.to_owned(),
    })
}

pub(crate) async fn read_range_diff(
    repo_root: &str,
    base: &str,
    old: &str,
    new: &str,
) -> anyhow::Result<GitRangeDiffResult> {
    time::timeout(TIMEOUT, async {
        let repo = crate::diff::discover_repo_root(repo_root)?;
        let base = resolve(&repo, "Base", base).await?;
        let old = resolve(&repo, "Old", old).await?;
        let new = resolve(&repo, "New", new).await?;
        // Git 2.50.1 range-diff.c read_patches() launches `log -p`, whose
        // cmd_log_init_defaults() enables textconv. Outer --no-textconv does NOT
        // propagate. Git has no config switch to disable all named converters.
        // Fail closed, including inactive drivers, before that nested log runs.
        let names = git(&repo, &["config", "--null", "--list", "--name-only"], 65_536).await?;
        if names.split('\0').any(|name| name.starts_with("diff.") && name.ends_with(".textconv")) {
            bail!("Range-diff cannot safely read repositories with configured textconv drivers; Git's nested log does not honor --no-textconv. Use Files compare instead");
        }
        for tip in [&old.oid, &new.oid] {
            let range = format!("{}..{tip}", base.oid);
            let commits = git(&repo, &["rev-list", "--no-merges", "--max-count=257", &range, "--"], 65_536).await?;
            if commits.lines().count() > COMMIT_LIMIT {
                bail!("Range-diff supports at most {COMMIT_LIMIT} non-merge commits per range; choose a closer Base");
            }
            // Native Git buffers each complete patch series before matching.
            // Check its input size as well as bounding the returned output.
            git(&repo, &["log", "--no-color", "--no-ext-diff", "--no-textconv",
                "--no-show-signature", "--no-merges", "--format=medium",
                "--show-notes-by-default", "--no-prefix", "--submodule=short", "-p", &range, "--"], PATCH_INPUT_LIMIT).await?;
        }
        let (output, truncated) = capture(git_command(&repo), &["range-diff",
            "--no-ext-diff", "--no-textconv", "--color=always", "--dual-color",
            &base.oid, &old.oid, &new.oid, "--"], OUTPUT_LIMIT).await?;
        Ok(GitRangeDiffResult { repo_root: repo.to_string_lossy().into_owned(), base, old, new, output, truncated })
    }).await.context("Git range-diff timed out after 15 seconds")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Oid, Repository, Signature};
    use std::{collections::BTreeMap, fs, path::PathBuf};
    use tempfile::TempDir;

    struct Fixture {
        temp: TempDir,
        repo: Repository,
        base: Oid,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = TempDir::new().unwrap();
            let repo = Repository::init(temp.path()).unwrap();
            let tree_oid = repo.treebuilder(None).unwrap().write().unwrap();
            let signature = Signature::new(
                "Range Tester",
                "range@example.invalid",
                &git2::Time::new(1_700_000_000, 0),
            )
            .unwrap();
            let base = repo
                .commit(
                    Some("HEAD"),
                    &signature,
                    &signature,
                    "base",
                    &repo.find_tree(tree_oid).unwrap(),
                    &[],
                )
                .unwrap();
            Self { temp, repo, base }
        }

        fn root(&self) -> &str {
            self.temp.path().to_str().unwrap()
        }

        fn commit(&self, parent: Oid, path: &str, text: &str, message: &str) -> Oid {
            let parent = self.repo.find_commit(parent).unwrap();
            let mut tree = self
                .repo
                .treebuilder(Some(&parent.tree().unwrap()))
                .unwrap();
            tree.insert(path, self.repo.blob(text.as_bytes()).unwrap(), 0o100644)
                .unwrap();
            let tree = self.repo.find_tree(tree.write().unwrap()).unwrap();
            let signature = Signature::new(
                "Range Tester",
                "range@example.invalid",
                &git2::Time::new(1_700_000_001, 0),
            )
            .unwrap();
            self.repo
                .commit(None, &signature, &signature, message, &tree, &[&parent])
                .unwrap()
        }

        fn config(&self, key: &str, value: &str) {
            self.repo.config().unwrap().set_str(key, value).unwrap();
        }
    }

    fn bytes(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        fn visit(root: &Path, path: &Path, result: &mut BTreeMap<PathBuf, Vec<u8>>) {
            for entry in fs::read_dir(path).unwrap() {
                let entry = entry.unwrap();
                if entry.file_type().unwrap().is_dir() {
                    visit(root, &entry.path(), result);
                } else {
                    result.insert(
                        entry.path().strip_prefix(root).unwrap().to_owned(),
                        fs::read(entry.path()).unwrap(),
                    );
                }
            }
        }
        let mut result = BTreeMap::new();
        visit(root, root, &mut result);
        result
    }

    fn plain(output: &str) -> String {
        let mut result = String::new();
        let mut chars = output.chars();
        while let Some(ch) = chars.next() {
            if ch == '\x1b' && chars.next() == Some('[') {
                for ch in chars.by_ref() {
                    if ch.is_ascii_alphabetic() {
                        break;
                    }
                }
            } else {
                result.push(ch);
            }
        }
        result
    }

    #[tokio::test]
    async fn three_refs_pin_upstream_and_preserve_native_reordered_and_changed_series() {
        let fixture = Fixture::new();
        let a = fixture.commit(fixture.base, "a", "alpha\n", "first independent patch");
        let b = fixture.commit(a, "b", "beta\n", "second independent patch");
        let old_body = (0..30)
            .map(|n| format!("shared line {n}\n"))
            .collect::<String>();
        let old = fixture.commit(b, "changed", &old_body, "adjust implementation");
        let new_b = fixture.commit(fixture.base, "b", "beta\n", "second independent patch");
        let new_a = fixture.commit(new_b, "a", "alpha\n", "first independent patch");
        let new = fixture.commit(
            new_a,
            "changed",
            &old_body.replace("line 15", "revised 15"),
            "adjust implementation",
        );
        assert_ne!(a, new_a);
        fixture
            .repo
            .reference("refs/remotes/origin/base", fixture.base, true, "fixture")
            .unwrap();
        fixture
            .repo
            .reference("refs/remotes/origin/topic", old, true, "fixture")
            .unwrap();
        fixture
            .repo
            .reference("refs/heads/topic", new, true, "fixture")
            .unwrap();
        fixture.repo.set_head("refs/heads/topic").unwrap();
        fixture.config("remote.origin.url", fixture.root());
        fixture.config("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
        fixture.config("branch.topic.remote", "origin");
        fixture.config("branch.topic.merge", "refs/heads/topic");
        let before = bytes(fixture.temp.path());
        let result = read_range_diff(fixture.root(), "origin/base", "@{u}", "HEAD")
            .await
            .unwrap();
        assert_eq!(result.base.oid, fixture.base.to_string());
        assert_eq!(result.old.oid, old.to_string());
        assert_eq!(result.new.oid, new.to_string());
        assert_eq!(result.old.input, "@{u}");
        let text = plain(&result.output);
        let summaries: Vec<_> = text.lines().filter(|line| !line.starts_with(' ')).collect();
        assert!(
            summaries
                .iter()
                .any(|line| line.contains(" = ") && line.contains("first independent patch"))
        );
        assert!(
            summaries
                .iter()
                .any(|line| line.contains(" = ") && line.contains("second independent patch"))
        );
        assert!(
            summaries
                .iter()
                .any(|line| line.contains(" ! ") && line.contains("adjust implementation"))
        );
        let (native, _) = capture(
            git_command(fixture.temp.path()),
            &[
                "range-diff",
                "--no-ext-diff",
                "--no-textconv",
                "--color=always",
                "--dual-color",
                &fixture.base.to_string(),
                &old.to_string(),
                &new.to_string(),
                "--",
            ],
            OUTPUT_LIMIT,
        )
        .await
        .unwrap();
        assert_eq!(result.output, native);
        assert_eq!(bytes(fixture.temp.path()), before);
    }

    #[tokio::test]
    async fn empty_and_one_sided_ranges_and_invalid_refs_have_distinct_results() {
        let fixture = Fixture::new();
        let base = fixture.base.to_string();
        let tip = fixture
            .commit(fixture.base, "added", "addition\n", "new patch")
            .to_string();
        let empty = read_range_diff(fixture.root(), &base, &base, &base)
            .await
            .unwrap();
        assert_eq!(empty.output, "");
        assert!(!empty.truncated);
        let added = read_range_diff(fixture.root(), &base, &base, &tip)
            .await
            .unwrap();
        assert!(
            plain(&added.output)
                .lines()
                .any(|line| line.contains(" > "))
        );
        let removed = read_range_diff(fixture.root(), &base, &tip, &base)
            .await
            .unwrap();
        assert!(
            plain(&removed.output)
                .lines()
                .any(|line| line.contains(" < "))
        );
        for input in [
            "",
            " ",
            "missing-ref",
            "@{u}",
            "--output=owned",
            "HEAD..HEAD",
            "HEAD^{tree}",
            "WORKTREE",
        ] {
            assert!(
                read_range_diff(fixture.root(), &base, input, &tip)
                    .await
                    .is_err(),
                "{input:?}"
            );
        }
        assert!(!fixture.temp.path().join("owned").exists());
    }

    #[tokio::test]
    async fn native_output_cap_is_explicit_without_appended_synthetic_text() {
        let fixture = Fixture::new();
        let subject = "long native subject ".repeat(20_000);
        let tip = fixture
            .commit(fixture.base, "file", "text\n", &subject)
            .to_string();
        let base = fixture.base.to_string();
        let result = read_range_diff(fixture.root(), &base, &base, &tip)
            .await
            .unwrap();
        assert!(result.truncated);
        assert_eq!(result.output.len(), OUTPUT_LIMIT);
        let (native, truncated) = capture(
            git_command(fixture.temp.path()),
            &[
                "range-diff",
                "--no-ext-diff",
                "--no-textconv",
                "--color=always",
                "--dual-color",
                &base,
                &base,
                &tip,
                "--",
            ],
            OUTPUT_LIMIT + 1000,
        )
        .await
        .unwrap();
        assert!(truncated);
        assert_eq!(result.output, native[..OUTPUT_LIMIT]);
    }

    #[tokio::test]
    async fn oversized_series_fail_explicitly_without_partial_matching() {
        let fixture = Fixture::new();
        let mut tip = fixture.base;
        for n in 0..=COMMIT_LIMIT {
            tip = fixture.commit(tip, "file", &format!("{n}\n"), "series patch");
        }
        let error = read_range_diff(
            fixture.root(),
            &fixture.base.to_string(),
            &fixture.base.to_string(),
            &tip.to_string(),
        )
        .await
        .unwrap_err();
        assert!(format!("{error:#}").contains("256 non-merge commits"));
    }

    #[tokio::test]
    async fn oversized_patch_input_is_refused_before_native_matching() {
        let fixture = Fixture::new();
        let tip = fixture.commit(
            fixture.base,
            "file",
            &"x".repeat(PATCH_INPUT_LIMIT),
            "large patch",
        );
        let before = bytes(fixture.temp.path());
        let error = read_range_diff(
            fixture.root(),
            &fixture.base.to_string(),
            &fixture.base.to_string(),
            &tip.to_string(),
        )
        .await
        .unwrap_err();
        assert!(format!("{error:#}").contains("8000000-byte limit"));
        assert_eq!(bytes(fixture.temp.path()), before);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn hostile_helpers_and_replacements_never_execute_or_mutate_the_repository() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        let tip = fixture.commit(fixture.base, "file", "real content\n", "stored patch");
        let odb = fixture.repo.odb().unwrap();
        let commit = odb.read(tip).unwrap();
        let signed = std::str::from_utf8(commit.data()).unwrap().replacen("\n\n",
            "\ngpgsig -----BEGIN PGP SIGNATURE-----\n invalid fixture signature\n -----END PGP SIGNATURE-----\n\n", 1);
        let tip = odb
            .write(git2::ObjectType::Commit, signed.as_bytes())
            .unwrap();
        let replacement = fixture.commit(fixture.base, "file", "replacement\n", "replaced patch");
        fixture
            .repo
            .reference(&format!("refs/replace/{tip}"), replacement, true, "fixture")
            .unwrap();
        let probes = TempDir::new().unwrap();
        let marker = probes.path().join("executed");
        let script = probes.path().join("probe");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf executed > '{}'\nexit 99\n",
                marker.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        for key in [
            "diff.external",
            "diff.hostile.command",
            "core.fsmonitor",
            "core.pager",
            "pager.log",
            "pager.range-diff",
            "gpg.program",
            "filter.hostile.clean",
            "filter.hostile.process",
        ] {
            fixture.config(key, script.to_str().unwrap());
        }
        fixture.config("log.showSignature", "true");
        fs::write(
            fixture.temp.path().join(".git/info/attributes"),
            "* diff=hostile filter=hostile\n",
        )
        .unwrap();
        fs::write(fixture.temp.path().join("dirty"), "uncommitted\n").unwrap();
        let before = bytes(fixture.temp.path());
        let base = fixture.base.to_string();
        let result = read_range_diff(fixture.root(), &base, &base, &tip.to_string())
            .await
            .unwrap();
        assert!(plain(&result.output).contains("stored patch"));
        assert!(!plain(&result.output).contains("replaced patch"));
        assert_eq!(bytes(fixture.temp.path()), before);
        assert!(!marker.exists());
        fixture.config("diff.hostile.textconv", script.to_str().unwrap());
        fixture.config("diff.hostile.cachetextconv", "true");
        let before = bytes(fixture.temp.path());
        let error = read_range_diff(fixture.root(), &base, &base, &tip.to_string())
            .await
            .unwrap_err();
        assert!(format!("{error:#}").contains("textconv"));
        assert_eq!(bytes(fixture.temp.path()), before);
        assert!(!marker.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn missing_promisor_blob_never_fetches_or_creates_objects() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        let tip = fixture.commit(fixture.base, "file", "promised content\n", "missing blob");
        let tree = fixture.repo.find_commit(tip).unwrap().tree().unwrap();
        let blob = tree.get_name("file").unwrap().id().to_string();
        fs::remove_file(
            fixture
                .temp
                .path()
                .join(".git/objects")
                .join(&blob[..2])
                .join(&blob[2..]),
        )
        .unwrap();
        let probes = TempDir::new().unwrap();
        let marker = probes.path().join("fetched");
        let helper = probes.path().join("transport");
        fs::write(
            &helper,
            format!(
                "#!/bin/sh\nprintf fetched > '{}'\nexit 1\n",
                marker.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o755)).unwrap();
        fixture.config("remote.origin.url", &format!("ext::{}", helper.display()));
        fixture.config("remote.origin.promisor", "true");
        fixture.config("remote.origin.partialclonefilter", "blob:none");
        fixture.config("extensions.partialClone", "origin");
        fixture.config("protocol.ext.allow", "always");
        let before = bytes(fixture.temp.path());
        assert!(
            read_range_diff(
                fixture.root(),
                &fixture.base.to_string(),
                &fixture.base.to_string(),
                &tip.to_string()
            )
            .await
            .is_err()
        );
        assert!(!marker.exists());
        assert_eq!(bytes(fixture.temp.path()), before);
    }

    #[tokio::test]
    async fn selected_repo_ignores_inherited_git_environment() {
        const CHILD: &str = "FURA_RANGE_DIFF_ENV_TEST_CHILD";
        if std::env::var_os(CHILD).is_some() {
            let fixture = Fixture::new();
            let base = fixture.base.to_string();
            let result = read_range_diff(fixture.root(), &base, &base, &base)
                .await
                .unwrap();
            assert_eq!(
                result.repo_root,
                fixture
                    .temp
                    .path()
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
            );
            assert_eq!(result.base.oid, base);
            return;
        }
        let other = Fixture::new();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "range_diff::tests::selected_repo_ignores_inherited_git_environment",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env("GIT_DIR", other.temp.path().join(".git"))
            .env("GIT_WORK_TREE", other.temp.path())
            .env("GIT_COMMON_DIR", other.temp.path().join(".git"))
            .env(
                "GIT_OBJECT_DIRECTORY",
                other.temp.path().join(".git/objects"),
            )
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "diff.hostile.textconv")
            .env("GIT_CONFIG_VALUE_0", "false")
            .env("GIT_EXEC_PATH", "/nonexistent-git-exec-path")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_kills_nested_subprocesses() {
        let temp = TempDir::new().unwrap();
        let ready = temp.path().join("ready");
        let survived = temp.path().join("survived");
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(format!(
            "(sleep 1; printf survived > '{}') & printf ready > '{}'; wait",
            survived.display(),
            ready.display()
        ));
        command
            .process_group(0)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let task = tokio::spawn(async move { capture(command, &[], 100).await });
        time::timeout(Duration::from_secs(5), async {
            while !ready.exists() {
                time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        time::sleep(Duration::from_millis(1200)).await;
        assert!(!survived.exists());
    }
}
