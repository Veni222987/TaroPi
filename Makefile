.PHONY: test release

REMOTE ?= origin
MESSAGE ?=

# test 运行 taropi-core 单元测试并生成本地覆盖率报告。
test:
	npm run test:coverage

# release 先拉取当前分支以暴露冲突，再递增最外围补丁版本；仅当 workspace 在递增前已有未提交改动时同步递增其补丁版本，提交当前工作区并推送当前 GitHub 分支。
release:
	@set -eu; \
	branch="$$(git branch --show-current)"; test -n "$$branch" || { echo "当前不在分支上，无法发布。"; exit 1; }; \
	remote_url="$$(git remote get-url "$(REMOTE)")"; case "$$remote_url" in *github.com*) ;; *) echo "$(REMOTE) 不是 GitHub 远端：$$remote_url"; exit 1;; esac; \
	git pull --autostash --no-edit "$(REMOTE)" "$$branch" || { echo "拉取失败或存在冲突，已停止发布。"; exit 1; }; \
	changed_workspaces="$$(node -e 'const fs=require("node:fs"); const {execFileSync}=require("node:child_process"); const names=JSON.parse(fs.readFileSync("package.json","utf8")).workspaces??[]; for (const name of names) { if (!fs.existsSync(name+"/package.json")) continue; const output=execFileSync("git",["status","--porcelain","--untracked-files=all","--",name+"/"],{encoding:"utf8"}); if (output.trim()) process.stdout.write(name+"\n"); }')"; \
	npm version patch --no-git-tag-version --ignore-scripts; \
	for workspace in $$changed_workspaces; do npm version patch --workspace="$$workspace" --no-git-tag-version --ignore-scripts; done; \
	version="$$(node -p "require('./package.json').version")"; \
	git add -A; \
	commit_message="release v$$version"; \
	if test -n "$(MESSAGE)"; then commit_message="$$commit_message $(MESSAGE)"; fi; \
	git commit -m "$$commit_message"; \
	git push "$(REMOTE)" "HEAD:$$branch"
