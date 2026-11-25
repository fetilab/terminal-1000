// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

// 必须显式 import：Kotlin DSL 里 `java` 被 JavaPluginExtension 遮蔽，
// 直接写 `java.util.zip.ZipFile` 会报 Unresolved reference: util。
import java.util.zip.ZipFile

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/**
 * 目标 ABI。发布用默认值 arm64-v8a；在开发机上做模拟器验收时
 * 用 `-Pt1000Abi=x86_64` 打一份 x86_64 包（jniLibs 下需要先跑过
 * `scripts/fetch-runtime.sh x86_64`）。
 */
val t1000Abi: String = (project.findProperty("t1000Abi") as String?) ?: "arm64-v8a"

android {
    namespace = "dev.t1000.android"
    compileSdk = 35
    /**
     * 显式钉住 build-tools 版本。
     *
     * 不写的话 AGP 8.7 默认要 34.0.0，而本机/CI 只装了 35.0.0，
     * 报错形如 `Failed to find Build Tools revision 34.0.0` —— 与代码无关，
     * 纯粹是工具链版本对不上。钉死后换机器也能复现同一套工具。
     */
    buildToolsVersion = "35.0.0"
    ndkVersion = "27.2.12479018"

    defaultConfig {
        applicationId = "dev.t1000.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 300
        versionName = "0.3.0"

        // 只发 arm64：Node 运行时与原生模块都要针对 ABI 单独提供，
        // 每多一个 ABI 就多一份 40MB+ 的运行时与两套编译产物。
        // 32 位设备（2018 年前）跑不动这个量级的终端应用，明确不支持。
        //
        // 例外：模拟器验收。x86_64 只用于在开发机上跑一遍真实链路
        // （-Pt1000Abi=x86_64），发布产物始终是 arm64-v8a。
        ndk {
            abiFilters += listOf(t1000Abi)
        }

        /**
         * testhook 开关：默认**关闭**，用 `-Pt1000TestHook=true` 打开。
         *
         * 不能"debug 包就自动打开"：主进程的 testhook 分支会把 userData 换成
         * tmp 下的随机目录（防止测试污染真实数据），对调试包来说副作用是
         * 设置与连接每次启动都丢 —— 用户手上一装就觉得"这 app 存不住东西"。
         */
        val testHook = (project.findProperty("t1000TestHook") as String?) ?: "false"
        buildConfigField("boolean", "T1000_TEST_HOOK", testHook)
    }

    /**
     * `extractNativeLibs` 必须为 true（= useLegacyPackaging）。
     *
     * 注意：AGP 8 起，**`android:extractNativeLibs` 不再能从 manifest 设置** ——
     * manifest 里写了会被忽略，只能在打包选项里设。
     * 若不设，`.so` 会以未压缩形式留在 APK 里由 linker 直接 mmap，
     * 而 mmap 映射的内存**没有执行权限**，于是 `libnode.so` 无法作为可执行文件启动。
     * 这一条是"Node 进程起不来"的最常见死因。
     */
    packaging {
        jniLibs {
            useLegacyPackaging = true

            /**
             * **proot 系列绝对不能 strip。**
             *
             * 这几份 .so 是 `patchelf` 改过的（`--set-soname` / `--replace-needed`
             * / `--set-rpath`）。patchelf 修改 ELF 时会把 `.interp`、`.dynstr` 追加到
             * 新的页边界，中间留一段填充，于是最后一个 PT_LOAD 变成
             * `p_offset=0x44000 / p_vaddr=0x50000`（两者 mod 0x4000 相等，合法）。
             *
             * AGP 默认会用 `llvm-strip` 清符号，而它会把这截填充删掉、**却不修正
             * `p_offset`**：文件里变成 `p_offset=0x431b0 / p_vaddr=0x50000`，
             * 偏移与地址不再同余 → `linker64` 映射错位 → proot 在 `main()` 之前
             * 就 SIGSEGV，输出 0 字节、logcat 无崩溃记录。
             *
             * 这个症状极具迷惑性：同一份源码手工推到 /data/local/tmp 跑完全正常
             * （没被 strip），装进 APK 就崩，且崩得毫无信息量。
             * keepDebugSymbols 让 MergeNativeLibs 跳过 strip，保持二进制与
             * `scripts/build-rootfs.sh` 的产物逐字节一致。
             * 下方的 `verifyNativeLibs` 任务会断言这一点。
             */
            keepDebugSymbols += setOf(
                "**/libproot.so",
                "**/libproot-loader.so",
                "**/libtalloc.so",
                "**/libandroid-shmem.so",
            )
        }
        resources {
            excludes += setOf(
                "META-INF/*.kotlin_module",
                "META-INF/LICENSE*",
                "META-INF/NOTICE*",
            )
        }
    }

    /**
     * `assets/rootfs.tgz` 本来就是 gzip，让 aapt 再压一遍纯属浪费。
     *
     * 后缀刻意用 `.tgz` 而不是 `.tar.gz`：aapt 对 `.gz` 结尾的 asset 有
     * "自动解压并改名"的遗留行为，会把 3.7MB 的包变成 APK 里 8.7MB 的 tar。
     */
    androidResources {
        noCompress += setOf("tgz")
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            isDebuggable = true
            // 调试包也打上同一个 applicationIdSuffix 之外的后缀会改变包名，
            // 导致 `run-as` 与文件路径对不上；这里不加后缀，便于用真实包名排查
        }
        release {
            isMinifyEnabled = false // APK 主体是 assets 里的 JS，混淆 Java 层收益极低
            isShrinkResources = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        // BuildConfig 用来注入 testhook 开关（见 defaultConfig 里的说明）
        buildConfig = true
    }

    sourceSets {
        getByName("main") {
            // 渲染层与 node host 产物都在这里（由 node-host/build.mjs 生成）
            assets.srcDirs("src/main/assets")
        }
    }

    /**
     * 依赖原生模块与 Node 运行时的完整性检查。
     *
     * 这些文件不在 git 里（体积大且需按 ABI 编译），缺了会打出一个"能装但起不来"的
     * 空壳 APK —— 那是最难排查的形态（安装成功、点开闪退、日志里只有一行 dlopen 失败）。
     * 所以在构建期就显式失败，并告诉开发者该跑哪条命令。
     */
    applicationVariants.all {
        val variant = this
        tasks.named("merge${variant.name.replaceFirstChar { it.uppercase() }}Assets").configure {
            doFirst {
                val jniDir = file("src/main/jniLibs/$t1000Abi")
                val required = listOf("libnode.so")
                val missing = required.filter { !File(jniDir, it).exists() }
                if (missing.isNotEmpty()) {
                    throw GradleException(
                        """
                        |缺少 Android 原生运行时（$t1000Abi）：${missing.joinToString(", ")}
                        |请先运行：
                        |  bash apps/android/scripts/fetch-runtime.sh $t1000Abi
                        |（会下载 Termux 的 Node 并准备成 libnode.so + 依赖库）
                        """.trimMargin(),
                    )
                }
            }
        }

        /**
         * 打包后逐字节校验 proot 系列。
         *
         * `keepDebugSymbols` 是"希望别 strip"，这里是"确认没被 strip"。
         * 两者的必要性来自同一个坑：被 strip 的 proot 会以 SIGSEGV + 零输出
         * 的形式失败，从设备侧几乎无法定位（见 packaging.jniLibs 的注释）。
         * 与其在设备上猜，不如让构建直接失败。
         */
        tasks.named("package${variant.name.replaceFirstChar { it.uppercase() }}").configure {
            doLast {
                val apk = outputs.files.files.firstOrNull { it.name.endsWith(".apk") && it.exists() }
                    ?: return@doLast
                val jniDir = file("src/main/jniLibs/$t1000Abi")
                val mustMatch = listOf(
                    "libproot.so",
                    "libproot-loader.so",
                    "libtalloc.so",
                    "libandroid-shmem.so",
                )
                ZipFile(apk).use { zip ->
                    for (name in mustMatch) {
                        val src = File(jniDir, name)
                        if (!src.exists()) continue // 没准备 proot 时允许缺席
                        val entry = zip.getEntry("lib/$t1000Abi/$name")
                            ?: throw GradleException("APK 缺少 lib/$t1000Abi/$name")
                        val packed = zip.getInputStream(entry).use { it.readBytes() }
                        if (!packed.contentEquals(src.readBytes())) {
                            throw GradleException(
                                """
                                |$name 在 APK 中与 jniLibs 源文件不一致（被 strip / 重写）。
                                |后果：proot 在 main() 之前 SIGSEGV，输出 0 字节，无 logcat 崩溃记录。
                                |请确认 packaging.jniLibs.keepDebugSymbols 覆盖了该文件。
                                |APK 内 ${packed.size} 字节，源文件 ${src.length()} 字节。
                                """.trimMargin(),
                            )
                        }
                    }
                }
            }
        }
    }
}

dependencies {
    // WebViewCompat.addDocumentStartJavaScript：在页面任何脚本之前注入桥。
    // 这是"替代 preload"的唯一正规途径（evaluateJavascript 时机太晚，
    // 渲染层首屏就会读 window.t1000.platform）。
    implementation("androidx.webkit:webkit:1.12.1")

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")

    // 回环 WebSocket 客户端（连 node host 的 /native）
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
