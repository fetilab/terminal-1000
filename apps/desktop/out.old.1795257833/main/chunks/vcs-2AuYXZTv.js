const VCS_SPECS = {
  git: {
    subs: [
      ["status", "查看工作区状态"],
      ["add", "把改动加入暂存区"],
      ["commit", "提交暂存区改动"],
      ["push", "推送到远端"],
      ["pull", "拉取并合并远端改动"],
      ["fetch", "只拉取不合并"],
      ["clone", "克隆仓库"],
      ["checkout", "切换分支或恢复文件"],
      ["switch", "切换分支"],
      ["branch", "管理分支"],
      ["merge", "合并分支"],
      ["rebase", "变基"],
      ["log", "查看提交历史"],
      ["diff", "查看差异"],
      ["show", "查看对象内容"],
      ["reset", "重置当前分支或暂存区"],
      ["restore", "恢复工作区文件"],
      ["stash", "暂存当前改动"],
      ["tag", "管理标签"],
      ["remote", "管理远端"],
      ["revert", "生成反向提交"],
      ["cherry-pick", "挑选提交"],
      ["blame", "逐行标注作者"],
      ["bisect", "二分查找引入问题的提交"],
      ["config", "读写仓库或全局配置"]
    ],
    opts: [
      ["-m", "提交信息", "MSG"],
      ["-a", "自动暂存已跟踪文件的改动"],
      ["-b", "创建并切换分支", "NAME"],
      ["-d", "删除分支", "NAME"],
      ["-u", "设置上游分支", "REMOTE"],
      ["--amend", "修改最近一次提交"],
      ["--force", "强制推送（危险）"],
      ["--oneline", "单行显示历史"],
      ["--stat", "显示改动统计"],
      ["--hard", "硬重置（丢弃改动）"]
    ],
    example: "git commit -m 'fix: 修复补全排序'"
  },
  gh: {
    subs: [
      ["pr", "管理 Pull Request"],
      ["issue", "管理 Issue"],
      ["repo", "管理仓库"],
      ["run", "查看工作流运行"],
      ["auth", "登录与凭据管理"],
      ["release", "管理发布"],
      ["api", "直接调用 API"],
      ["gist", "管理 gist"]
    ],
    opts: [
      ["--repo", "指定仓库", "OWNER/REPO"],
      ["--web", "在浏览器中打开"],
      ["--help", "显示帮助"]
    ]
  },
  svn: {
    subs: [
      ["checkout", "检出工作副本"],
      ["update", "更新工作副本"],
      ["commit", "提交改动"],
      ["add", "纳入版本控制"],
      ["delete", "删除条目"],
      ["status", "查看状态"],
      ["log", "查看日志"],
      ["diff", "查看差异"],
      ["revert", "撤销本地改动"],
      ["info", "查看工作副本信息"],
      ["switch", "切换分支"]
    ],
    opts: [
      ["-m", "提交信息", "MSG"],
      ["-r", "指定版本号", "REV"],
      ["--username", "用户名", "USER"],
      ["--password", "密码", "PASS"]
    ]
  },
  hg: {
    subs: [
      ["status", "查看状态"],
      ["add", "加入版本控制"],
      ["commit", "提交改动"],
      ["push", "推送到远端"],
      ["pull", "拉取改动"],
      ["update", "更新工作目录"],
      ["merge", "合并分支"],
      ["log", "查看历史"],
      ["diff", "查看差异"],
      ["branch", "管理分支"],
      ["revert", "撤销改动"]
    ],
    opts: [
      ["-m", "提交信息", "MSG"],
      ["-r", "指定版本", "REV"],
      ["-u", "指定用户", "USER"]
    ]
  }
};
export {
  VCS_SPECS
};
