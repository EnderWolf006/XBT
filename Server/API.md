# 学不通 2.0 后端接口文档

- Base URL: `http://<host>:3030`
- REST 前缀: `/api`
- 返回格式统一:

```json
{
  "code": 0,
  "message": "ok",
  "data": {}
}
```

`code = 0` 表示成功，`code = 1` 表示失败。

## 1. 鉴权说明

### 1.1 Bearer Token
除登录与健康检查外，所有 REST 接口都需要在请求头携带：

```http
Authorization: Bearer <JWT>
```

### 1.2 权限等级
- `permission = 1`: 普通用户
- `permission = 2`: 管理员

白名单管理接口仅管理员可访问。

---

## 2. 通用接口

### 2.1 健康检查
- Method: `GET`
- Path: `/api/health`
- Auth: 否

响应示例：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "service": "xbt2-server"
  }
}
```

---

## 3. 认证接口

### 3.1 登录
- Method: `POST`
- Path: `/api/auth/login`
- Auth: 否

请求体：

```json
{
  "mobile": "13800000000",
  "password": "your_password"
}
```

响应体：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "token": "<jwt>",
    "user": {
      "uid": 123456,
      "name": "张三",
      "mobile": "138****0000",
      "avatar": "https://...",
      "permission": 2
    }
  }
}
```

说明：
- 若白名单为空，首次登录用户会自动成为管理员（`permission=2`）。
- 若账号不在白名单，会返回未授权。

---

## 4. 课程接口

### 4.1 获取课程列表
- Method: `GET`
- Path: `/api/courses`
- Auth: 是

响应体 `data`:

```json
[
  {
    "class_id": 111,
    "course_id": 222,
    "name": "高等数学",
    "teacher": "李老师",
    "icon": "https://...",
    "is_selected": true
  }
]
```

### 4.2 同步课程
- Method: `POST`
- Path: `/api/courses/sync`
- Auth: 是

请求体：无

响应体 `data`:

```json
{
  "count": 12
}
```

### 4.3 更新监控课程选择
- Method: `PUT`
- Path: `/api/courses/selection`
- Auth: 是

请求体：

```json
{
  "course_ids": [222, 333]
}
```

响应体 `data`:

```json
{
  "selected_count": 2
}
```

说明：
- 当前实现按 `course_id` 更新选中状态（与前端当前实现一致）。

---

## 5. 签到接口

### 5.1 获取已选课程的签到活动
- Method: `GET`
- Path: `/api/sign/activities`
- Auth: 是

响应体 `data`:

```json
[
  {
    "course_id": 222,
    "class_id": 111,
    "course_name": "高等数学",
    "course_teacher": "李老师",
    "icon": "https://...",
    "has_more": false,
    "activities": [
      {
        "active_id": 987654,
        "activity_name": "课堂签到",
        "start_time": 1760000000000,
        "end_time": 1760003600000,
        "sign_type": 2,
        "if_refresh_ewm": false,
        "record_source": 0,
        "record_source_name": "",
        "record_sign_time": 1760000500000,
        "course_name": "高等数学",
        "course_id": 222,
        "class_id": 111,
        "course_teacher": "李老师"
      }
    ]
  }
]
```

`record_source` 含义：
- `0`: 尚未签到。
- `-1`: 该同学已在学习通自行签到。
- `= 当前用户 uid`: 该同学由当前用户代签（本人签到时也是该值）。
- `>0 且 != 当前用户 uid`: 该同学已被其他用户代签。

`record_source_name` 含义：
- `""` (空字符串): 尚未签到。
- `"学习通"`: 该同学已在学习通自行签到。
- 其他字符串（例如 `"张三"`）: 表示该同学被该用户代签。

`sign_type` 含义：
- `0` 普通签到
- `2` 二维码签到
- `3` 手势签到
- `4` 位置签到
- `5` 签到码签到

说明：
- 每门课程默认最多返回最新 `5` 条签到活动（可通过后端 `Server/config.yaml` 中的 `activity_list_limit` 配置）。
- 当该课程活动总数超过返回条数时，`has_more=true`。

### 5.2 获取同班同学（可代签目标）
- Method: `GET`
- Path: `/api/sign/classmates`
- Auth: 是
- Query:
  - `course_id` (required)
  - `class_id` (required)

示例：

```http
GET /api/sign/classmates?course_id=222&class_id=111
```

响应体 `data`:

```json
[
  {
    "uid": 10001,
    "name": "王五",
    "mobile_masked": "139****0000",
    "avatar": "https://..."
  }
]
```

### 5.3 查询待签状态
- Method: `POST`
- Path: `/api/sign/check`
- Auth: 是

请求体：

```json
{
  "activity_id": 987654,
  "user_ids": [10001, 10002]
}
```

说明：
- 后端会自动把当前登录用户加入查询列表。
- 前端可据此过滤出未签用户，再自行并发调用执行签到接口。

响应体 `data`:

```json
{
  "items": [
    {
      "user_id": 343479151,
      "signed": true,
      "record_source": 343479151,
      "record_source_name": "张三",
      "message": "该同学已本人签到"
    },
    {
      "user_id": 10001,
      "signed": false,
      "record_source": 0,
      "record_source_name": "",
      "message": "未签到"
    }
  ]
}
```

### 5.4 执行单用户签到
- Method: `POST`
- Path: `/api/sign/execute`
- Auth: 是

请求体：

```json
{
  "activity_id": 987654,
  "target_uid": 10001,
  "sign_type": 2,
  "course_id": 222,
  "class_id": 111,
  "if_refresh_ewm": false,
  "special_params": {
    "enc": "xxxx",
    "location": {
      "result": 1,
      "address": "成都市郫都区xxx",
      "latitude": 30.7501,
      "longitude": 103.9272
    }
  }
}
```

兼容说明：
- 若未传 `target_uid`，但传了 `user_ids`，后端会使用 `user_ids` 的第一个 uid。
- 若都未传，默认签当前登录用户。

响应体 `data`:

```json
{
  "user_id": 10001,
  "success": true,
  "already_signed": false,
  "record_source": 343479151,
  "record_source_name": "张三",
  "message": "签到成功"
}
```

`special_params` 按签到类型：
- 普通签到(`0`): 可空
- 二维码签到(`2`):
  - `enc` (required)
  - `c` (optional, 预签到场景可用)
  - `location` (optional, 二维码附加位置变种；可传对象/数组或 JSON 字符串，后端会透传给学习通)
  - `latitude` + `longitude` + `description` (optional, 兼容写法；后端会自动组装为 `location` 后透传)
- 手势签到(`3`):
  - `sign_code` (required)
- 位置签到(`4`):
  - `latitude` (required)
  - `longitude` (required)
  - `description` (required)
- 签到码签到(`5`):
  - `sign_code` (required)

---

## 6. 白名单管理接口（管理员）

> 该组接口已重构为 RESTful 资源风格，仅管理普通用户白名单（permission 固定为 1）。

### 6.1 获取普通用户白名单
- Method: `GET`
- Path: `/api/admin/whitelist/users`
- Auth: 是（管理员）

响应体 `data`:

```json
[
  {
    "id": 12,
    "uid": 343479453,
    "mobile_masked": "139****0000",
    "permission": 1
  }
]
```

### 6.2 添加普通用户白名单
- Method: `POST`
- Path: `/api/admin/whitelist/users`
- Auth: 是（管理员）

请求体：

```json
{
  "mobile": "13900000000"
}
```

响应体 `data`:

```json
{
  "id": 12,
  "uid": 343479453,
  "mobile_masked": "139****0000",
  "permission": 1
}
```

说明：
- 该接口不再接受 `permission` 参数。
- 管理员账号不会被该接口修改。

### 6.3 批量导入普通用户白名单
- Method: `POST`
- Path: `/api/admin/whitelist/users/import`
- Auth: 是（管理员）

请求体：

```json
{
  "mobiles": "13900000001\n13900000002,13900000003"
}
```

响应体 `data`:

```json
{
  "count": 3,
  "skipped_admin": 0
}
```

说明：
- 支持换行、逗号、空格混合文本。
- 自动提取手机号并去重。
- 若手机号是管理员白名单，会被跳过并计入 `skipped_admin`。

### 6.4 删除普通用户白名单
- Method: `DELETE`
- Path: `/api/admin/whitelist/users/:id`
- Auth: 是（管理员）

示例：

```http
DELETE /api/admin/whitelist/users/12
```

响应体 `data`:

```json
{
  "id": 12,
  "uid": 0,
  "mobile_masked": "139****0000"
}
```

说明：
- 管理员账号不允许删除。

---

## 7. 错误码与常见错误

统一结构：

```json
{
  "code": 1,
  "message": "error message",
  "data": null
}
```

常见 HTTP 状态码：
- `400` 参数错误
- `401` 未登录或 token 无效
- `403` 权限不足
- `404` 资源不存在
- `500` 服务端错误

---

## 8. 联调建议

1. 先调用 `/api/auth/login` 获取 JWT。
2. 带 `Authorization: Bearer <JWT>` 调用 `/api/courses/sync`。
3. 调用 `/api/courses` + `/api/courses/selection` 选定课程。
4. 调用 `/api/sign/activities` 拿活动。
5. 调用 `/api/sign/check` 查待签状态。
6. 前端过滤出未签用户后，并发调用 `/api/sign/execute`。
