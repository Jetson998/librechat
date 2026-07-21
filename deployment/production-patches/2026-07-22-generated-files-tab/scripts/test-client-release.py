from pathlib import Path

root = Path(__file__).resolve().parents[1]
script = (root / "client/generated-files-tab.js").read_text(encoding="utf-8")
style = (root / "client/generated-files-tab.css").read_text(encoding="utf-8")
route = (root / "api/generated-files.js").read_text(encoding="utf-8")
user_route = (root / "api/user.js").read_text(encoding="utf-8")

required_script = (
    "上传的文件",
    "生成的文件",
    "/api/user/generated-files",
    "downloadPath",
    "conversationPath",
    "MutationObserver",
    "role=\"tab\"",
    "credentials: 'same-origin'",
    "tableRegion.previousElementSibling",
    "tableRegion.parentElement",
)
for marker in required_script:
    assert marker in script, marker

required_style = (
    ".lc-generated-files-tabs",
    ".lc-generated-files-table",
    ".lc-generated-files-footer",
    ":focus-visible",
    "@media (max-width: 720px)",
)
for marker in required_style:
    assert marker in style, marker

required_route = (
    "isCreatedByUser: false",
    "artifactRole': { $ne: 'intermediate' }",
    "'file.context': 'execute_code'",
    "user: userId",
    "allowDiskUse(false)",
)
for marker in required_route:
    assert marker in route, marker

assert "router.get('/generated-files', requireJwtAuth, generatedFilesHandler);" in user_route
assert "createUsageDashboardHandler" in user_route
assert "configMiddleware, usageDashboardHandler" in user_route
assert "req.query.user" not in route
assert "response" not in route.lower()
assert '<div class="native-table"><div class="native-table-scroll"><table>' in (
    root / "scripts/fixture.html"
).read_text(encoding="utf-8")

print("generated-files client and route release checks passed")
