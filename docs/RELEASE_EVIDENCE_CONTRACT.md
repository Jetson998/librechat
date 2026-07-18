# 发布证据契约

发布记录使用与工具供应商无关的字段。Git commit、CI run、镜像 digest、
备份路径等具体值放在对应对象的 `details` 中，不成为通用协议的硬编码
前提。

## 必要字段

```json
{
  "schema_version": 1,
  "release_id": "",
  "project_id": "",
  "mode": "light|release|protected|enhanced",
  "status": "planned|ready|in_progress|deployed|rolled_back|blocked|failed",
  "source_revision": "",
  "change_summary": {
    "reason": "",
    "functions": [],
    "scope": [],
    "expected_result": "",
    "risk": "",
    "limitations": []
  },
  "baseline_reference": {"status": "passed", "details": {}},
  "validation_plan": [],
  "artifact_digest": {"status": "passed", "details": {}},
  "build_attestation": {"status": "passed", "details": {}},
  "runtime_snapshot": {"status": "passed", "details": {}},
  "backup_reference": {"status": "passed", "details": {}},
  "acceptance_result": {"status": "passed", "details": {}},
  "rollback_reference": {"status": "passed", "details": {}},
  "unresolved_issues": []
}
```

对象可以是 `not_applicable`，但必须有 `reason`，且必须被所选项目模式
预先允许。发布记录不能只写“已完成”，应保留实际路径、摘要、状态和未解决
问题。

## 证据生命周期

1. `prepare` 创建计划和基线引用。
2. `preflight_permissions` 证明所需能力和只读外部依赖可用。
3. `repository_gate` 证明计划和源版本来自正确项目。
4. `package_manifest` 证明制品内容和摘要。
5. `ci_attestation_gate` 证明构建或制品来源。
6. `target_preflight` 记录生产变更前快照。
7. `apply_gate` 记录实际写入目标、runner 和返回结果。
8. `acceptance_gate` 记录变更后行为。
9. `release_record` 关闭记录并保存未解决问题。

中断时只保存 checkpoint 和证据文件；最终事实必须回写到单次发布记录并
提交到仓库。
