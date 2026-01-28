# Qiita API v2 Specification

投稿に必要なAPI仕様のまとめ。

## Authentication

```
Authorization: Bearer {QIITA_TOKEN}
```

トークン発行: Qiita → 設定 → アプリケーション → 個人用アクセストークン

必要なスコープ: `write_qiita`

## POST /api/v2/items

新しい記事を作成。

### Request

```bash
curl -X POST \
  -H "Authorization: Bearer $QIITA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "記事タイトル",
    "body": "本文（Markdown）",
    "tags": [{"name": "Tag1"}, {"name": "Tag2"}],
    "private": true
  }' \
  "https://qiita.com/api/v2/items"
```

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| title | string | ✅ | 記事タイトル |
| body | string | ✅ | 本文（Markdown） |
| tags | array | ✅ | タグ配列（最大5個） |
| private | boolean | ❌ | `true`: 限定共有, `false`: 公開 |
| tweet | boolean | ❌ | Twitter投稿（デフォルト: false） |

### Tags Format

```json
{
  "tags": [
    {"name": "JavaScript"},
    {"name": "React", "versions": ["18.0"]}
  ]
}
```

### Response (201 Created)

```json
{
  "id": "c686397e4a0f4f11683d",
  "url": "https://qiita.com/username/items/c686397e4a0f4f11683d",
  "title": "記事タイトル",
  "private": true,
  "created_at": "2025-01-20T10:00:00+09:00",
  ...
}
```

### Error Response

```json
{
  "message": "Bad request",
  "type": "bad_request"
}
```

## Rate Limits

| 認証 | 制限 |
|------|------|
| なし | 60回/時間 |
| あり | 1000回/時間 |

## Reference

- [Qiita API v2 Documentation](https://qiita.com/api/v2/docs)
