// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

// t1000-agent：常驻远端监控代理（**单文件静态二进制，零运行时依赖**）。
//
// 为什么是 Go 而不是脚本：
//   早先的实现要求远端有 python3 —— 但大量服务器（最小化安装的 CentOS、
//   Alpine、容器镜像、老发行版）根本没有 python3，代理装不上就只能退回
//   每拍 fork 一段 shell 的"脚本模式"，开销大、速率也不准。
//   Go 的 CGO_ENABLED=0 产物是真正的静态可执行文件，只依赖内核，
//   连 glibc 都不需要，任何 Linux（含 musl 发行版）都能直接跑。
//
// 与桌面端的契约（改动必须同步 apps/desktop/src/main/services/monitor/agent.ts）：
//   GET /health?token=…   → {"ok":true,"version":…,"pid":…,"uptimeSeconds":…}
//   GET /metrics?token=…&modules=cpu,memory&limit=8
//                         → 各模块字段平铺在同一层 JSON 里；单个模块出错写进
//                           `_errors`，绝不因为一个模块异常而整份失败
//   GET /quit             → {"ok":true} 后退出
//   token 校验用常量时间比较；状态文件 0600、临时文件 + rename 原子落盘
//   空闲 idle 秒无请求就自杀，避免在服务器上留一个常驻进程
package main

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

/** 代理版本。**改动行为时必须递增**：桌面端据此判断远端要不要重装。 */
const agentVersion = "3.0.0"

var startAt = time.Now()

// ── /proc 读取 ──────────────────────────────────────────────────────────────

func readFile(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(b)
}

type cpuPair struct{ busy, idle float64 }

type coreRow struct {
	index      int
	busy, idle float64
}

// readCPUSnapshot 返回汇总与逐核的 (busy, idle) 累计值（jiffies）。
// busy 的口径与 Python 版一致：总和减去 idle+iowait，即"非空闲"。
func readCPUSnapshot() (*cpuPair, []coreRow) {
	var total *cpuPair
	var cores []coreRow
	for _, line := range strings.Split(readFile("/proc/stat"), "\n") {
		if !strings.HasPrefix(line, "cpu") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		vals := make([]float64, 0, len(fields)-1)
		for _, f := range fields[1:] {
			v, err := strconv.ParseFloat(f, 64)
			if err != nil {
				vals = nil
				break
			}
			vals = append(vals, v)
		}
		if len(vals) < 4 {
			continue
		}
		idle := vals[3]
		if len(vals) > 4 {
			idle += vals[4]
		}
		sum := 0.0
		for _, v := range vals {
			sum += v
		}
		busy := sum - idle
		if fields[0] == "cpu" {
			total = &cpuPair{busy: busy, idle: idle}
			continue
		}
		idx, err := strconv.Atoi(strings.TrimPrefix(fields[0], "cpu"))
		if err != nil {
			idx = len(cores)
		}
		cores = append(cores, coreRow{index: idx, busy: busy, idle: idle})
	}
	return total, cores
}

func cpuModelName() string {
	for _, line := range strings.Split(readFile("/proc/cpuinfo"), "\n") {
		if strings.HasPrefix(line, "model name") || strings.HasPrefix(line, "Hardware") {
			if _, v, ok := strings.Cut(line, ":"); ok {
				if s := strings.TrimSpace(v); s != "" {
					return s
				}
			}
		}
	}
	return ""
}

func physicalCores() int {
	seen := map[string]struct{}{}
	phys := ""
	for _, line := range strings.Split(readFile("/proc/cpuinfo"), "\n") {
		if strings.HasPrefix(line, "physical id") {
			if _, v, ok := strings.Cut(line, ":"); ok {
				phys = strings.TrimSpace(v)
			}
		} else if strings.HasPrefix(line, "core id") {
			if _, v, ok := strings.Cut(line, ":"); ok {
				seen[phys+"/"+strings.TrimSpace(v)] = struct{}{}
			}
		}
	}
	if len(seen) == 0 {
		return 0
	}
	return len(seen)
}

func cpuTemperature() (float64, bool) {
	paths, _ := filepath.Glob("/sys/class/thermal/thermal_zone*/temp")
	best := int64(-1)
	for _, p := range paths {
		s := strings.TrimSpace(readFile(p))
		v, err := strconv.ParseInt(s, 10, 64)
		if err != nil || v <= 0 {
			continue
		}
		if v > best {
			best = v
		}
	}
	if best < 0 {
		return 0, false
	}
	return round1(float64(best) / 1000), true
}

func meminfo() map[string]int64 {
	out := map[string]int64{}
	for _, line := range strings.Split(readFile("/proc/meminfo"), "\n") {
		name, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		v, err := strconv.ParseInt(fields[0], 10, 64)
		if err != nil {
			continue
		}
		out[strings.TrimSpace(name)] = v
	}
	return out
}

type netRow struct {
	name   string
	rx, tx int64
}

func netSnapshot() []netRow {
	lines := strings.Split(readFile("/proc/net/dev"), "\n")
	if len(lines) <= 2 {
		return nil
	}
	var rows []netRow
	for _, line := range lines[2:] {
		name, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		name = strings.TrimSpace(name)
		if name == "lo" || strings.HasPrefix(name, "veth") || name == "docker0" {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) < 9 {
			continue
		}
		rx, err1 := strconv.ParseInt(fields[0], 10, 64)
		tx, err2 := strconv.ParseInt(fields[8], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		rows = append(rows, netRow{name: name, rx: rx, tx: tx})
	}
	return rows
}

type diskPair struct{ read, write int64 }

func diskSnapshot() map[string]diskPair {
	out := map[string]diskPair{}
	for _, line := range strings.Split(readFile("/proc/diskstats"), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 10 {
			continue
		}
		name := fields[2]
		if !strings.HasPrefix(name, "sd") && !strings.HasPrefix(name, "vd") &&
			!strings.HasPrefix(name, "hd") && !strings.HasPrefix(name, "xvd") &&
			!strings.HasPrefix(name, "nvme") && !strings.HasPrefix(name, "mmcblk") &&
			!strings.HasPrefix(name, "md") {
			continue
		}
		rd, err1 := strconv.ParseInt(fields[5], 10, 64)
		wr, err2 := strconv.ParseInt(fields[9], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		out[name] = diskPair{read: rd, write: wr}
	}
	return out
}

func deviceBase(name string) string {
	if strings.HasPrefix(name, "nvme") || strings.HasPrefix(name, "mmcblk") {
		if head, tail, ok := strings.Cut(name, "p"); ok {
			if _, err := strconv.Atoi(tail); err == nil {
				return head
			}
		}
		return name
	}
	if name != "" {
		if _, err := strconv.Atoi(name[len(name)-1:]); err == nil {
			trimmed := strings.TrimRight(name, "0123456789")
			if trimmed != "" {
				return trimmed
			}
		}
	}
	return name
}

var pseudoFS = map[string]struct{}{
	"tmpfs": {}, "devtmpfs": {}, "devpts": {}, "proc": {}, "sysfs": {}, "cgroup": {},
	"cgroup2": {}, "securityfs": {}, "debugfs": {}, "tracefs": {}, "configfs": {},
	"mqueue": {}, "hugetlbfs": {}, "pstore": {}, "bpf": {}, "autofs": {}, "fusectl": {},
	"squashfs": {}, "efivarfs": {}, "rpc_pipefs": {}, "overlay": {}, "nsfs": {},
}

type mountTarget struct {
	mount, device, fstype string
}

func diskTargets() []mountTarget {
	seen := map[string]struct{}{}
	var out []mountTarget
	for _, line := range strings.Split(readFile("/proc/mounts"), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		device, mount, fstype := fields[0], unescapeMount(fields[1]), fields[2]
		if _, ok := pseudoFS[fstype]; ok {
			continue
		}
		if _, ok := seen[mount]; ok {
			continue
		}
		seen[mount] = struct{}{}
		out = append(out, mountTarget{mount: mount, device: device, fstype: fstype})
	}
	return out
}

// unescapeMount：/proc/mounts 把空格等字节转义成 \040 形式的八进制。
func unescapeMount(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

type procRaw struct {
	ticks   int64
	started int64
	raw     string
}

// procSnapshot：pid → (utime+stime, starttime, stat 原文)，一次读盘供 CPU% 与 RSS 共用。
func procSnapshot() map[int]procRaw {
	out := map[int]procRaw{}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return out
	}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		raw := readFile("/proc/" + e.Name() + "/stat")
		if raw == "" {
			continue
		}
		close := strings.LastIndex(raw, ")")
		if close < 0 || close+2 >= len(raw) {
			continue
		}
		rest := strings.Fields(raw[close+2:])
		if len(rest) < 22 {
			continue
		}
		utime, err1 := strconv.ParseInt(rest[11], 10, 64)
		stime, err2 := strconv.ParseInt(rest[12], 10, 64)
		started, err3 := strconv.ParseInt(rest[19], 10, 64)
		if err1 != nil || err2 != nil || err3 != nil {
			continue
		}
		out[pid] = procRaw{ticks: utime + stime, started: started, raw: raw}
	}
	return out
}

// ── GPU ─────────────────────────────────────────────────────────────────────

func nvidiaGPUs() []map[string]any {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "nvidia-smi",
		"--query-gpu=index,name,utilization.gpu,memory.total,memory.used,temperature.gpu",
		"--format=csv,noheader,nounits")
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var gpus []map[string]any
	for _, line := range strings.Split(string(out), "\n") {
		cells := strings.Split(line, ",")
		if len(cells) < 6 {
			continue
		}
		for i := range cells {
			cells[i] = strings.TrimSpace(cells[i])
		}
		idx, _ := strconv.Atoi(cells[0])
		item := map[string]any{"index": idx, "name": cells[1]}
		if v, err := strconv.ParseFloat(cells[2], 64); err == nil {
			item["utilization"] = round1(v)
		}
		if v, err := strconv.ParseFloat(cells[3], 64); err == nil {
			item["memoryTotalBytes"] = int64(v * 1048576)
		}
		if v, err := strconv.ParseFloat(cells[4], 64); err == nil {
			item["memoryUsedBytes"] = int64(v * 1048576)
		}
		if v, err := strconv.ParseFloat(cells[5], 64); err == nil {
			item["temperatureC"] = round1(v)
		}
		gpus = append(gpus, item)
	}
	return gpus
}

func amdGPUs() []map[string]any {
	cards, _ := filepath.Glob("/sys/class/drm/card[0-9]")
	sort.Strings(cards)
	var gpus []map[string]any
	for i, card := range cards {
		base := filepath.Join(card, "device")
		busy := strings.TrimSpace(readFile(filepath.Join(base, "gpu_busy_percent")))
		total := strings.TrimSpace(readFile(filepath.Join(base, "mem_info_vram_total")))
		used := strings.TrimSpace(readFile(filepath.Join(base, "mem_info_vram_used")))
		if busy == "" && total == "" {
			continue
		}
		item := map[string]any{"index": i, "name": "AMD GPU"}
		if v, err := strconv.ParseFloat(busy, 64); err == nil {
			item["utilization"] = clampPct(v)
		}
		if v, err := strconv.ParseInt(total, 10, 64); err == nil {
			item["memoryTotalBytes"] = v
		}
		if v, err := strconv.ParseInt(used, 10, 64); err == nil {
			item["memoryUsedBytes"] = v
		}
		gpus = append(gpus, item)
	}
	return gpus
}

// ── 采集器 ──────────────────────────────────────────────────────────────────

func round1(v float64) float64 { return math.Round(v*10) / 10 }

func clampPct(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

type Collector struct {
	mu sync.Mutex

	prevCPU   *cpuPair
	prevCores map[int]cpuPair

	prevNet    map[string]netRow
	prevNetAt  time.Time
	prevDisk   map[string]diskPair
	prevDiskAt time.Time

	prevProc   map[int]int64
	prevProcAt time.Time
	procCache  []map[string]any
	procCacheAt time.Time

	gpuCache   []map[string]any
	gpuCacheAt time.Time

	page  int64
	clk   int64
	model string
	logical int
	physical int

	users map[int]string
}

func newCollector() *Collector {
	return &Collector{
		page:     int64(os.Getpagesize()),
		clk:      100, // Linux 上 SC_CLK_TCK 恒为 100（USER_HZ）
		model:    cpuModelName(),
		logical:  runtime.NumCPU(),
		physical: physicalCores(),
		users:    map[int]string{},
	}
}

func (c *Collector) system() map[string]any {
	distro, release := "", ""
	for _, line := range strings.Split(readFile("/etc/os-release"), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		switch key {
		case "ID":
			distro = value
		case "VERSION_ID":
			release = value
		}
	}
	out := map[string]any{}
	if h, err := os.Hostname(); err == nil {
		out["hostname"] = h
	}
	var uts syscall.Utsname
	if err := syscall.Uname(&uts); err == nil {
		out["kernel"] = charsToString(uts.Release[:])
		out["arch"] = charsToString(uts.Machine[:])
	}
	if distro != "" {
		out["distro"] = distro
	}
	if release != "" {
		out["release"] = release
	}
	if tz := strings.TrimSpace(readFile("/etc/timezone")); tz != "" {
		out["timezone"] = tz
	} else {
		out["timezone"] = time.Now().Format("MST")
	}
	if fields := strings.Fields(readFile("/proc/uptime")); len(fields) > 0 {
		if up, err := strconv.ParseFloat(fields[0], 64); err == nil && up > 0 {
			out["uptimeSeconds"] = int64(up)
		}
	}
	if fields := strings.Fields(readFile("/proc/loadavg")); len(fields) >= 3 {
		load := make([]float64, 0, 3)
		for _, f := range fields[:3] {
			if v, err := strconv.ParseFloat(f, 64); err == nil {
				load = append(load, round1(v))
			}
		}
		if len(load) == 3 {
			out["loadAvg"] = load
		}
	}
	return out
}

func charsToString[T int8 | uint8](arr []T) string {
	buf := make([]byte, 0, len(arr))
	for _, c := range arr {
		if c == 0 {
			break
		}
		buf = append(buf, byte(c))
	}
	return string(buf)
}

func (c *Collector) cpu() map[string]any {
	now, cores := readCPUSnapshot()
	prev := c.prevCPU
	prevCores := c.prevCores
	if prev == nil && now != nil {
		// 首拍没有增量：短暂等待后重采一次，只发生一次
		time.Sleep(120 * time.Millisecond)
		prev = now
		prevCores = indexCores(cores)
		now, cores = readCPUSnapshot()
	}
	c.prevCPU = now
	c.prevCores = indexCores(cores)

	usage := 0.0
	if prev != nil && now != nil {
		total := (now.busy + now.idle) - (prev.busy + prev.idle)
		if total > 0 {
			usage = clampPct((now.busy - prev.busy) * 100 / total)
		}
	}
	coreRows := make([]map[string]any, 0, len(cores))
	for _, row := range cores {
		pct := 0.0
		if base, ok := prevCores[row.index]; ok {
			total := (row.busy + row.idle) - (base.busy + base.idle)
			if total > 0 {
				pct = clampPct((row.busy - base.busy) * 100 / total)
			}
		}
		coreRows = append(coreRows, map[string]any{"index": row.index, "usage": round1(pct)})
	}
	out := map[string]any{"usage": round1(usage), "cores": coreRows}
	if c.model != "" {
		out["model"] = c.model
	}
	if c.logical > 0 {
		out["logicalCount"] = c.logical
	}
	if c.physical > 0 {
		out["physicalCount"] = c.physical
	}
	if temp, ok := cpuTemperature(); ok {
		out["temperatureC"] = temp
	}
	return out
}

func indexCores(rows []coreRow) map[int]cpuPair {
	m := make(map[int]cpuPair, len(rows))
	for _, r := range rows {
		m[r.index] = cpuPair{busy: r.busy, idle: r.idle}
	}
	return m
}

func (c *Collector) memory() map[string]any {
	info := meminfo()
	total := info["MemTotal"]
	if total <= 0 {
		return nil
	}
	free := info["MemFree"]
	buff := info["Buffers"]
	cached := info["Cached"]
	srec := info["SReclaimable"]
	used := total - free - buff - cached - srec
	if used < 0 {
		used = 0
	}
	out := map[string]any{
		"totalBytes": total * 1024,
		"usedBytes":  used * 1024,
		"freeBytes":  free * 1024,
	}
	if cachedBytes := (buff + cached + srec) * 1024; cachedBytes > 0 {
		out["cachedBytes"] = cachedBytes
	}
	if swapTotal := info["SwapTotal"]; swapTotal > 0 {
		swapFree := info["SwapFree"]
		if used := swapTotal - swapFree; used > 0 {
			out["swapUsedBytes"] = used * 1024
		} else {
			out["swapUsedBytes"] = int64(0)
		}
		out["swapTotalBytes"] = swapTotal * 1024
	}
	return out
}

func (c *Collector) network() map[string]any {
	rows := netSnapshot()
	if len(rows) == 0 {
		return nil
	}
	stamp := time.Now()
	prev := c.prevNet
	prevAt := c.prevNetAt
	cur := make(map[string]netRow, len(rows))
	for _, r := range rows {
		cur[r.name] = r
	}
	c.prevNet = cur
	c.prevNetAt = stamp
	dt := 0.0
	if !prevAt.IsZero() {
		dt = stamp.Sub(prevAt).Seconds()
	}

	var totalRx, totalTx, speedRx, speedTx int64
	items := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		totalRx += r.rx
		totalTx += r.tx
		item := map[string]any{"name": r.name, "rxBytes": r.rx, "txBytes": r.tx}
		if base, ok := prev[r.name]; ok && dt >= 0.2 {
			irx := float64(max64(0, r.rx-base.rx)) / dt
			itx := float64(max64(0, r.tx-base.tx)) / dt
			item["rxSpeed"] = int64(irx)
			item["txSpeed"] = int64(itx)
			speedRx += int64(irx)
			speedTx += int64(itx)
		}
		items = append(items, item)
	}
	return map[string]any{
		"interfaces":   items,
		"rxTotalBytes": totalRx,
		"txTotalBytes": totalTx,
		"rxSpeed":      speedRx,
		"txSpeed":      speedTx,
	}
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func (c *Collector) disk() map[string]any {
	stamp := time.Now()
	now := diskSnapshot()
	prev := c.prevDisk
	prevAt := c.prevDiskAt
	dt := 0.0
	if !prevAt.IsZero() {
		dt = stamp.Sub(prevAt).Seconds()
	}
	speeds := map[string][2]float64{}
	if dt >= 0.2 {
		for name, cur := range now {
			base, ok := prev[name]
			if !ok {
				continue
			}
			speeds[deviceBase(name)] = [2]float64{
				float64(max64(0, cur.read-base.read)) * 512 / dt,
				float64(max64(0, cur.write-base.write)) * 512 / dt,
			}
		}
	}
	c.prevDisk = now
	c.prevDiskAt = stamp

	parts := make([]map[string]any, 0, 8)
	var readSum, writeSum float64
	seen := map[string]struct{}{}
	for _, t := range diskTargets() {
		var st syscall.Statfs_t
		if err := syscall.Statfs(t.mount, &st); err != nil {
			continue
		}
		block := int64(st.Frsize)
		if block == 0 {
			block = int64(st.Bsize)
		}
		total := int64(st.Blocks) * block
		if total <= 0 {
			continue
		}
		avail := int64(st.Bavail) * block
		free := int64(st.Bfree) * block
		used := total - free
		if used < 0 {
			used = 0
		}
		// btrfs 子卷指向同一文件系统：按 (device,total,used) 去重，否则卡片重复三遍
		fingerprint := fmt.Sprintf("%s|%d|%d", t.device, total, used)
		if _, ok := seen[fingerprint]; ok {
			continue
		}
		seen[fingerprint] = struct{}{}
		item := map[string]any{
			"mount":          t.mount,
			"device":         t.device,
			"fsType":         t.fstype,
			"totalBytes":     total,
			"usedBytes":      used,
			"availableBytes": avail,
			"usedPercent":    round1(clampPct(float64(used) * 100 / float64(total))),
		}
		base := deviceBase(filepath.Base(t.device))
		if sp, ok := speeds[base]; ok {
			item["readSpeed"] = int64(sp[0])
			item["writeSpeed"] = int64(sp[1])
			readSum += sp[0]
			writeSum += sp[1]
		}
		parts = append(parts, item)
	}
	return map[string]any{"partitions": parts, "readSpeed": int64(readSum), "writeSpeed": int64(writeSum)}
}

func (c *Collector) processes(limit int) []map[string]any {
	stamp := time.Now()
	// 1 秒内复用上一次结果：多客户端/多请求不会把 /proc 扫两遍
	if c.procCache != nil && stamp.Sub(c.procCacheAt) < time.Second {
		if limit > len(c.procCache) {
			return c.procCache
		}
		return c.procCache[:limit]
	}

	totalKB := meminfo()["MemTotal"]
	now := procSnapshot()
	prev := c.prevProc
	prevAt := c.prevProcAt
	dt := 0.0
	if !prevAt.IsZero() {
		dt = stamp.Sub(prevAt).Seconds()
	}

	rows := make([]map[string]any, 0, len(now))
	for pid, entry := range now {
		cpu := 0.0
		if base, ok := prev[pid]; ok && dt >= 0.2 {
			cpu = math.Max(0, float64(entry.ticks-base)*100/(dt*float64(c.clk)))
		}
		close := strings.LastIndex(entry.raw, ")")
		if close < 0 {
			continue
		}
		rest := strings.Fields(entry.raw[close+2:])
		if len(rest) < 22 {
			continue
		}
		rss, _ := strconv.ParseInt(rest[21], 10, 64)
		name := entry.raw[strings.Index(entry.raw, "(")+1 : close]
		cmdline := strings.TrimSpace(strings.NewReplacer("\x00", " ", "\n", " ").Replace(readFile("/proc/" + strconv.Itoa(pid) + "/cmdline")))
		command := name
		if cmdline != "" {
			if len(cmdline) > 160 {
				cmdline = cmdline[:160]
			}
			command = cmdline
		}
		mem := 0.0
		if totalKB > 0 {
			mem = float64(rss*c.page/1024) * 100 / float64(totalKB)
		}
		row := map[string]any{
			"pid":       pid,
			"command":   command,
			"cpu":       round1(cpu),
			"memory":    round1(mem),
			"state":     rest[0],
			"startedAt": entry.started,
		}
		if user := c.username(pid); user != "" {
			row["user"] = user
		}
		rows = append(rows, row)
	}
	sort.SliceStable(rows, func(i, j int) bool {
		a, b := rows[i]["cpu"].(float64), rows[j]["cpu"].(float64)
		if a != b {
			return a > b
		}
		return rows[i]["memory"].(float64) > rows[j]["memory"].(float64)
	})
	if len(rows) > 200 {
		rows = rows[:200]
	}
	c.prevProc = make(map[int]int64, len(now))
	for pid, e := range now {
		c.prevProc[pid] = e.ticks
	}
	c.prevProcAt = stamp
	c.procCache = rows
	c.procCacheAt = stamp
	if limit > len(rows) {
		return rows
	}
	return rows[:limit]
}

func (c *Collector) username(pid int) string {
	if name, ok := c.users[pid]; ok {
		return name
	}
	var st syscall.Stat_t
	if err := syscall.Stat("/proc/"+strconv.Itoa(pid), &st); err != nil {
		return ""
	}
	name := lookupUser(st.Uid)
	if len(c.users) < 4000 {
		c.users[pid] = name
	}
	return name
}

func (c *Collector) gpu() []map[string]any {
	stamp := time.Now()
	if c.gpuCache != nil && stamp.Sub(c.gpuCacheAt) < 5*time.Second {
		return c.gpuCache
	}
	gpus := nvidiaGPUs()
	if len(gpus) == 0 {
		gpus = amdGPUs()
	}
	c.gpuCache = gpus
	c.gpuCacheAt = stamp
	return gpus
}

// payload 按模块名组装响应。模块顺序由调用方给，缺数据就整块不出现（与 Python 版一致）。
func (c *Collector) payload(modules []string, limit int) map[string]any {
	out := map[string]any{}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, name := range modules {
		switch name {
		case "system":
			out["system"] = c.system()
		case "cpu":
			out["cpu"] = c.cpu()
		case "memory":
			if v := c.memory(); v != nil {
				out["memory"] = v
			}
		case "network":
			if v := c.network(); v != nil {
				out["network"] = v
			}
		case "disk":
			out["disk"] = c.disk()
		case "process":
			if rows := c.processes(limit); len(rows) > 0 {
				out["processes"] = rows
			}
		case "gpu":
			if gpus := c.gpu(); len(gpus) > 0 {
				out["gpu"] = gpus
			}
		}
	}
	return out
}

// ── HTTP ────────────────────────────────────────────────────────────────────

var (
	token    string
	stateFile string
	idleSec  int64 = 900
	lastTouch atomic.Int64
)

func touch() { lastTouch.Store(time.Now().UnixNano()) }

func main() {
	port := flag.Int("port", 0, "监听端口（0 = 由内核分配）")
	state := flag.String("state", "agent-state.json", "状态文件路径")
	tok := flag.String("token", "", "访问 token（空则随机生成）")
	idle := flag.Int("idle", 900, "空闲多少秒后退出")
	showVersion := flag.Bool("version", false, "打印版本后退出")
	flag.Parse()

	if *showVersion {
		fmt.Println(agentVersion)
		return
	}

	stateFile = *state
	token = *tok
	if token == "" {
		token = randomToken()
	}
	idleSec = int64(*idle)
	if idleSec < 60 {
		idleSec = 60
	}
	touch()

	collector := newCollector()

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		fmt.Fprintf(os.Stderr, "listen: %v\n", err)
		os.Exit(1)
	}
	actualPort := ln.Addr().(*net.TCPAddr).Port

	if err := writeState(actualPort); err != nil {
		fmt.Fprintf(os.Stderr, "state: %v\n", err)
		os.Exit(1)
	}
	defer cleanupState()

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		given := r.URL.Query().Get("token")
		if given == "" {
			given = r.Header.Get("X-T1000-Token")
		}
		if subtle.ConstantTimeCompare([]byte(given), []byte(token)) != 1 {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden"})
			return
		}
		touch()
		switch r.URL.Path {
		case "/health":
			writeJSON(w, http.StatusOK, map[string]any{
				"ok":            true,
				"version":       agentVersion,
				"pid":           os.Getpid(),
				"uptimeSeconds": int64(time.Since(startAt).Seconds()),
			})
		case "/metrics":
			raw := r.URL.Query().Get("modules")
			var modules []string
			for _, m := range strings.Split(raw, ",") {
				if m != "" {
					modules = append(modules, m)
				}
			}
			if len(modules) == 0 {
				modules = []string{"system", "cpu", "memory", "network", "disk", "process", "gpu"}
			}
			limit, err := strconv.Atoi(r.URL.Query().Get("limit"))
			if err != nil {
				limit = 8
			}
			if limit < 1 {
				limit = 1
			} else if limit > 200 {
				limit = 200
			}
			writeJSON(w, http.StatusOK, collector.payload(modules, limit))
		case "/quit":
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
			go func() {
				time.Sleep(50 * time.Millisecond)
				cleanupState()
				os.Exit(0)
			}()
		default:
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		}
	})

	// 空闲自杀：服务器上不该留一个没人用的常驻进程
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			last := time.Unix(0, lastTouch.Load())
			if time.Since(last) > time.Duration(idleSec)*time.Second {
				cleanupState()
				os.Exit(0)
			}
		}
	}()

	// 收到 TERM/INT 也要把状态文件删掉，否则桌面端会以为代理还活着
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigs
		cleanupState()
		os.Exit(0)
	}()

	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		fmt.Fprintf(os.Stderr, "serve: %v\n", err)
		os.Exit(1)
	}
}

func writeJSON(w http.ResponseWriter, status int, obj any) {
	body, err := json.Marshal(obj)
	if err != nil {
		http.Error(w, `{"error":"encode"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func writeState(port int) error {
	payload := map[string]any{
		"port":      port,
		"pid":       os.Getpid(),
		"token":     token,
		"version":   agentVersion,
		"startedAt": startAt.Unix(),
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if dir := filepath.Dir(stateFile); dir != "" {
		_ = os.MkdirAll(dir, 0o700)
	}
	tmp := stateFile + ".tmp"
	if err := os.WriteFile(tmp, body, 0o600); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, stateFile)
}

func cleanupState() {
	_ = os.Remove(stateFile)
}

func randomToken() string {
	buf := make([]byte, 16)
	f, err := os.Open("/dev/urandom")
	if err == nil {
		_, _ = io.ReadFull(f, buf)
		_ = f.Close()
	}
	const hex = "0123456789abcdef"
	out := make([]byte, len(buf)*2)
	for i, b := range buf {
		out[i*2] = hex[b>>4]
		out[i*2+1] = hex[b&0x0f]
	}
	return string(out)
}

// lookupUser 只读 /etc/passwd，避免引入 cgo（user.Lookup 在 CGO_ENABLED=0 下也是纯 Go，
// 但要解析 NSS 配置；这里只认本地账户，够用且没有外部依赖）。
func lookupUser(uid uint32) string {
	f, err := os.Open("/etc/passwd")
	if err != nil {
		return ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Split(scanner.Text(), ":")
		if len(fields) < 3 {
			continue
		}
		if v, err := strconv.ParseUint(fields[2], 10, 32); err == nil && uint32(v) == uid {
			return fields[0]
		}
	}
	return ""
}
