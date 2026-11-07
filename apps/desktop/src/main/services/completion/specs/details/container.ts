// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 「容器与虚拟化」分类的选项明细（本分类命中时才被加载）。自撰语料。
 */

import type { SpecRows } from '../types'

export const CONTAINER_SPECS: Record<string, SpecRows> = {
  docker: {
    subs: [
      ['run', '运行一个新容器'],
      ['exec', '在运行中容器内执行命令'],
      ['ps', '列出容器'],
      ['images', '列出镜像'],
      ['build', '构建镜像'],
      ['pull', '拉取镜像'],
      ['push', '推送镜像'],
      ['logs', '查看容器日志'],
      ['start', '启动容器'],
      ['stop', '停止容器'],
      ['rm', '删除容器'],
      ['rmi', '删除镜像'],
      ['compose', '编排命令入口'],
      ['inspect', '查看对象详情'],
      ['stats', '查看资源占用'],
    ],
    opts: [
      ['-d', '后台运行'],
      ['-it', '交互式终端'],
      ['-p', '端口映射', 'HOST:CONTAINER'],
      ['-v', '挂载卷', 'HOST:CONTAINER'],
      ['-e', '设置环境变量', 'KEY=VAL'],
      ['--name', '容器名', 'NAME'],
      ['--rm', '退出后自动删除'],
    ],
  },
  'docker-compose': {
    subs: [
      ['up', '创建并启动服务'],
      ['down', '停止并删除资源'],
      ['ps', '列出服务状态'],
      ['logs', '查看服务日志'],
      ['build', '构建服务镜像'],
      ['restart', '重启服务'],
      ['exec', '在服务内执行命令'],
      ['pull', '拉取服务镜像'],
      ['config', '校验并输出配置'],
    ],
    opts: [
      ['-d', '后台运行'],
      ['-f', '指定 compose 文件', 'FILE'],
      ['--project-name', '项目名', 'NAME'],
      ['--remove-orphans', '清理孤儿容器'],
    ],
  },
  kubectl: {
    subs: [
      ['get', '查询资源'],
      ['describe', '查看资源详情'],
      ['apply', '按清单创建或更新'],
      ['delete', '删除资源'],
      ['logs', '查看 Pod 日志'],
      ['exec', '进入容器执行命令'],
      ['create', '创建资源'],
      ['edit', '编辑资源'],
      ['scale', '调整副本数'],
      ['rolling-update', '滚动更新'],
      ['port-forward', '端口转发'],
      ['config', '管理 kubeconfig'],
      ['top', '查看资源占用'],
      ['drain', '驱逐节点上的 Pod'],
    ],
    opts: [
      ['-n', '指定命名空间', 'NAMESPACE'],
      ['-o', '输出格式', 'FORMAT'],
      ['-f', '从文件读取清单', 'FILE'],
      ['-l', '按标签筛选', 'SELECTOR'],
      ['--all-namespaces', '跨全部命名空间'],
      ['-w', '持续监听变化'],
    ],
  },
  podman: {
    subs: [
      ['run', '运行容器'],
      ['ps', '列出容器'],
      ['images', '列出镜像'],
      ['build', '构建镜像'],
      ['pull', '拉取镜像'],
      ['exec', '在容器内执行命令'],
      ['logs', '查看日志'],
      ['rm', '删除容器'],
      ['rmi', '删除镜像'],
      ['pod', '管理 Pod'],
    ],
    opts: [
      ['-d', '后台运行'],
      ['-it', '交互式终端'],
      ['-p', '端口映射', 'HOST:CONTAINER'],
      ['-v', '挂载卷', 'HOST:CONTAINER'],
      ['--name', '容器名', 'NAME'],
    ],
  },
  helm: {
    subs: [
      ['install', '安装 chart'],
      ['upgrade', '升级 release'],
      ['uninstall', '卸载 release'],
      ['list', '列出 release'],
      ['repo', '管理 chart 仓库'],
      ['search', '搜索 chart'],
      ['template', '本地渲染模板'],
      ['show', '查看 chart 内容'],
      ['rollback', '回滚 release'],
    ],
    opts: [
      ['-n', '命名空间', 'NAMESPACE'],
      ['-f', '指定 values 文件', 'FILE'],
      ['--set', '覆盖单个值', 'KEY=VAL'],
      ['--dry-run', '只演练不安装'],
      ['--values', '同 -f', 'FILE'],
    ],
  },
  minikube: {
    subs: [
      ['start', '启动本地集群'],
      ['stop', '停止集群'],
      ['delete', '删除集群'],
      ['status', '查看集群状态'],
      ['dashboard', '打开控制台'],
      ['ssh', '进入节点 shell'],
      ['service', '获取服务地址'],
      ['addons', '管理插件'],
    ],
    opts: [
      ['-p', '指定 profile', 'NAME'],
      ['--driver', '指定驱动', 'DRIVER'],
      ['--cpus', '分配 CPU 数', 'N'],
      ['--memory', '分配内存', 'SIZE'],
    ],
  },
  kind: {
    subs: [
      ['create', '创建集群'],
      ['delete', '删除集群'],
      ['get', '查询集群'],
      ['load', '把镜像载入集群'],
      ['export', '导出日志与配置'],
    ],
    opts: [
      ['--name', '集群名', 'NAME'],
      ['--config', '指定配置文件', 'FILE'],
      ['--image', '节点镜像', 'IMAGE'],
    ],
  },
  ctr: {
    subs: [
      ['images', '列出镜像'],
      ['containers', '列出容器'],
      ['run', '运行容器'],
      ['pull', '拉取镜像'],
      ['rm', '删除容器'],
      ['namespaces', '管理命名空间'],
      ['tasks', '管理任务'],
    ],
    opts: [
      ['-n', '指定命名空间', 'NAMESPACE'],
      ['--address', 'containerd 地址', 'PATH'],
    ],
  },
  lxc: {
    subs: [
      ['list', '列出容器'],
      ['launch', '创建并启动容器'],
      ['start', '启动容器'],
      ['stop', '停止容器'],
      ['delete', '删除容器'],
      ['info', '查看容器信息'],
      ['exec', '在容器内执行命令'],
      ['snapshot', '管理快照'],
    ],
    opts: [
      ['-n', '按名字指定', 'NAME'],
      ['-f', '指定配置文件', 'FILE'],
      ['-t', '指定模板', 'TEMPLATE'],
    ],
  },
  virsh: {
    subs: [
      ['list', '列出虚拟机'],
      ['start', '启动虚拟机'],
      ['shutdown', '优雅关机'],
      ['destroy', '强制关机'],
      ['reboot', '重启虚拟机'],
      ['console', '连接串口控制台'],
      ['define', '从 XML 定义虚拟机'],
      ['dominfo', '查看虚拟机信息'],
      ['snapshot-create', '创建快照'],
    ],
    opts: [
      ['-c', '指定连接 URI', 'URI'],
      ['--all', '包含未运行的域'],
      ['--domain', '指定域', 'DOMAIN'],
    ],
  },
}
