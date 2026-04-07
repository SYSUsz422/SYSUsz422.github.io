# 由 Hugo 驱动的网站

## 本地编译

从 [GitHub](https://github.com/gohugoio/hugo/releases/) 下载 Hugo 生成器的预构建二进制文件，并将 `hugo` 添加到您的系统路径中。
如果您使用包管理器，也可以参照 [官方安装指南](https://gohugo.io/installation/) 进行安装。

### 克隆主仓库

```sh
git clone git@github.com:SYSUsz422/SYSUsz422.github.io.git
cd SYSUsz422.github.io
```

### 初始化并更新子模块（如果使用主题子模块）

网站使用的主题存储为子模块（例如在 `themes/` 目录下）：

```sh
git submodule update --init --depth=1 --recursive
```


### 基础生产环境构建（输出到 ./public/ 目录）

```sh
hugo --minify -e production
```

### 故障排除

- **找不到主题**：确保主题子模块已初始化：运行 `git submodule update --init`。
- **版本不匹配**：使用 `hugo version` 检查 Hugo 版本，并确保其与项目所需的版本一致（参见 `hugo.mod` 文件）。
- **缺少资源文件**：清除缓存：在重新构建前运行 `hugo clean`。
- 如有其他问题，请查阅 [Hugo 文档](https://gohugo.io/documentation/) 或在本仓库中提交 Issue。
- 如果您需要自定义任何部分（例如特定的主题设置、部署目标或额外命令），请告知我！

## 部署到 GitHub

请遵循 [此官方指南](https://gohugo.io/host-and-deploy/host-on-github-pages/)。