# 未成年人智能陪伴安全桥

本项目用于管理同意关系、风险信号与人工介入中的稳定事实和交换边界。仓库提供基础服务、数据库初始化入口、领域说明和一份脱敏示例，便于不同参与方在一致约定下协作。

## 目录

- `contracts/` 保存外部交换字段示例。
- `docs/` 说明领域对象、时间和标识约定。
- `src/`、`cmd/` 或 `internal/` 保存服务代码。
- `tests/` 保存基础行为检查。

## 运行

执行 `make test` 检查基础行为，执行 `make migrate` 初始化本地数据目录，执行 `make run` 启动服务。默认监听 `8080` 端口，健康检查地址为 `/health`。

配置通过环境变量传入，敏感值和本地数据库文件不得提交到仓库。

## 接口概览

- `POST /consents`、`POST /consents/{id}/withdraw`：按年龄段与监护关系登记、撤回知情同意。
- `POST /rulesets`：激活新版本规则集（已写入版本不可修改，旧判断保留旧版本）。
- `POST /events`：接收本地处理后的风险信号、使用时长与主动求助；幂等去重，拒绝任何可还原谈话的字段。
- `GET /cases/{id}`：按 `x-actor-role` / `x-actor-ref` 返回角色专属字段；越权访问拒绝并留痕。
- `GET /cases/{id}/proof`：复核者查看升级证明（持久化时间 + 每次披露的确切字段）。
- `POST /assessments/{id}/appeals`、`POST /appeals/{id}/resolve`：学生申诉与心理人员复核。
- `POST /subjects/{ref}/deletions`、`GET /deletions/{id}`、`POST /deletions/{id}/advance`：数据删除申请与进度。
- `GET /audit`、`GET /audit/verify`：哈希链审计日志查询与完整性校验（限心理人员/管理员）。
