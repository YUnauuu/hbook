# hbook

自托管的**漫画 + 小说**阅读站。漫画和小说在同一个网页里读，源自己加。

<img src="web/public/icons/hbook-mark.png" width="72" alt="hbook">

## 能做什么

- **漫画**：MangaDex、Mihon / Tachiyomi 扩展（由 Suwayomi 引擎跑）、`bff/manga-sites.json` 里的 36 个中文站点
  （站点类型在运行时自动认），也能在后台按地址加自己的站。
- **小说**：Legado（阅读）格式的书源规则，规则引擎是本项目自己写的。
- **放在一起**：同一个搜索框、同一个 18+ 开关。

## 装

要 Docker 和 Docker Compose。**装的时候不用克隆仓库**：

```bash
curl -O https://raw.githubusercontent.com/YUnauuu/hbook/main/deploy/docker-compose.yml
docker compose up -d
```

然后打开 <http://localhost:8080>。

默认起的是六栏的阅读器，不需要账号。想用带账号、收藏和管理后台的完整版，在 compose 文件的
`environment:` 里加一行 `WEB_ROOT: /app/web`。别的装法（独立数据库、HTTPS、CasaOS / Unraid / Umbrel）：
[docs/INSTALL.md](docs/INSTALL.md)。

## 六个栏目

| 栏目 | 是什么 |
| --- | --- |
| 漫画库 | 漫画。栏是后台慢慢攒起来的，边逛边长 |
| 书库 | 小说，按书源给的分类摆 |
| 最新更新 | 各源今天更新的 |
| 热门排行 | 跟的人最多的 |
| 搜索 | 漫画和小说一起搜。搜 `帝尊`，宅猪的那本排第一 |
| 历史记录 | 读过什么，存在你自己的浏览器里 |

首页是最新更新 + 热门排行 + 书库分类。

## 小说源

`novel-sources/` 里放 Legado 格式的 JSON：

- `legado-verified.json` —— 266 个，逐个验过能搜、能开目录、能读一章
- `adult.json` —— 37 个带 18+ 的
- `status.json` —— 探测结果：哪些活着，哪些没有，为什么

把 JSON 丢进这个目录，重启或者 `POST /api/novels/sources/reload` 就生效。

## 从源码跑

```bash
cd bff && npm install && npm run build && cd ..
./start-reader.sh
```

脚本自己拉起 Postgres、编译、等到接口真的回话为止；数据库认不出用户时，它会打印一条现成的命令。
前端就是 `reader/` 里的四个文件（HTML / CSS / JS 加一个 service worker），不用编译。

## 文档

[使用](docs/USAGE.md) · [安装](docs/INSTALL.md) · [阅读器](docs/READER.md) · [小说](docs/NOVELS.md) ·
[桌面版](docs/DESKTOP.md) · [配置](docs/CONFIGURATION.md) · [扩展](docs/extensions.md) ·
[API](docs/api.md) · [迁移](docs/MIGRATING.md) —— 都是英文的。

## 致谢与许可

hbook 源自 [Uchiyomi](https://github.com/AngeloSha/uchiyomi)（AngeloSha 与贡献者）：漫画那一半继承自它，
小说那一半是从零写的。许可 [MPL-2.0](LICENSE)。
