"""Real browser tests against the local-only fake GitHub, never real repositories.

Run from the repository root:
  venv/bin/python -m pytest prototypes/github-auth/tests/test_browser.py -q
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import time
from urllib.request import urlopen
from uuid import uuid4

import pytest
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def server():
    subprocess.run(["node", "tools/build-editor.mjs"], cwd=ROOT, check=True, capture_output=True)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    proc = subprocess.Popen(
        ["node", "--disable-warning=ExperimentalWarning", "tools/demo-server.mjs"],
        cwd=ROOT, env={**os.environ, "PORT": str(port)},
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    try:
        for _ in range(100):
            try:
                with urlopen(origin, timeout=1):
                    break
            except OSError:
                if proc.poll() is not None:
                    raise RuntimeError(proc.stderr.read().decode())
                time.sleep(0.05)
        else:
            raise RuntimeError("Demo server did not start")
        yield origin
    finally:
        proc.terminate()
        proc.wait(timeout=5)


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        yield browser
        browser.close()


@pytest.fixture
def page(browser, server):
    context = browser.new_context(viewport={"width": 1280, "height": 960})
    page = context.new_page()
    page.goto(server)
    expect(page.locator("#demo-banner")).to_be_visible()
    yield page
    context.close()


def login(page, user="demo-author"):
    page.get_by_role("button", name="Sign in with GitHub").click()
    page.get_by_role("link", name=f"Continue as {user}").click()
    expect(page.locator("#identity")).to_have_text(f"Signed in as @{user}")
    expect(page.locator("#repo-status")).to_have_text("2 writable repositories")


def select_repo(page, repo_id="1"):
    page.locator("#repos").select_option(repo_id)
    expect(page.locator("#branch-status")).to_contain_text("default:")


def destination(page):
    path = f"_posts/browser-test-{uuid4().hex}.md"
    page.locator("#path").fill(path)
    return path


def test_draft_survives_cancel_login_and_reload(page):
    page.locator("#content").fill("# My locally saved story\n\nCafé 🌱")
    page.get_by_role("button", name="Sign in with GitHub").click()
    page.get_by_role("link", name="Cancel sign-in").click()
    expect(page.locator("#feedback")).to_contain_text("Sign-in canceled")
    expect(page.locator("#content")).to_have_value("# My locally saved story\n\nCafé 🌱")
    page.reload()
    expect(page.locator("#content")).to_have_value("# My locally saved story\n\nCafé 🌱")
    expect(page.locator("#signed-out")).to_be_visible()


def test_sign_in_collaborator_picker_save_sign_out(page):
    page.locator("#content").fill("# Shared history\n\nA new story.")
    login(page)
    page.locator("#repo-search").fill("community")
    expect(page.locator("#repos option")).to_have_count(1)
    select_repo(page, "2")
    expect(page.locator("#branch")).to_have_value("trunk")
    destination(page)
    page.get_by_role("button", name="Review destination").click()
    expect(page.locator("#file-note")).to_contain_text("create a new")
    expect(page.locator("#destination-summary")).to_contain_text("community/shared-stories")
    page.locator("#confirm-save").click()
    expect(page.locator("#feedback")).to_contain_text("Saved to GitHub")
    expect(page.locator("#saved-link")).to_have_attribute("href", __import__("re").compile("https://github.com/community/shared-stories/blob/trunk/"))
    page.locator("#history").get_by_text("Local recovery copies").click()
    expect(page.locator("#history-list li")).to_have_count(1)
    page.get_by_role("button", name="Sign out", exact=True).click()
    expect(page.locator("#signed-out")).to_be_visible()
    expect(page.locator("#content")).to_have_value("# Shared history\n\nA new story.")
    storage = page.evaluate("JSON.stringify({...localStorage})")
    assert "fake-token" not in storage and "csrf" not in storage
    assert all(c["httpOnly"] for c in page.context.cookies())


def test_review_then_remote_change_requires_new_review(page, server):
    login(page)
    select_repo(page)
    path = destination(page)
    page.get_by_role("button", name="Review destination").click()
    session = page.context.request.get(f"{server}/api/session").json()
    response = page.context.request.post(f"{server}/api/github/save", headers={"Origin": server, "X-CSRF-Token": session["csrf"]}, data={"owner":"demo-author", "repo":"field-notes", "branch":"main", "path":path, "content":"A simultaneous remote change", "expectedSha":None})
    assert response.ok
    original = page.locator("#content").input_value()
    page.locator("#confirm-save").click()
    expect(page.locator("#feedback")).to_contain_text("file changed")
    expect(page.locator("#content")).to_have_value(original)
    page.get_by_role("button", name="Review destination").click()
    expect(page.locator("#file-note")).to_contain_text("already exists")
    expect(page.locator("#remote-content")).to_have_text("A simultaneous remote change")
    page.locator("#cancel-save").click()


def test_typing_while_save_in_flight_preserves_newer_local_content(page):
    login(page)
    select_repo(page)
    destination(page)
    page.locator("#content").fill("The submitted copy")
    page.get_by_role("button", name="Review destination").click()

    def during_save(route):
        assert json.loads(route.request.post_data)["content"] == "The submitted copy"
        response = route.fetch()
        page.evaluate("""() => {
          const editor = document.querySelector('#content');
          editor.value = 'New edits made during the request';
          editor.dispatchEvent(new Event('input', {bubbles:true}));
        }""")
        route.fulfill(response=response)

    page.route("**/api/github/save", during_save)
    page.locator("#confirm-save").click()
    expect(page.locator("#feedback")).to_contain_text("newer local edits")
    expect(page.locator("#content")).to_have_value("New edits made during the request")
    page.reload()
    expect(page.locator("#content")).to_have_value("New edits made during the request")


def test_new_branch_and_protected_branch_behavior(page):
    login(page)
    select_repo(page)
    destination(page)
    page.locator("#branch").select_option("protected")
    page.get_by_role("button", name="Review destination").click()
    page.locator("#confirm-save").click()
    expect(page.locator("#feedback")).to_contain_text("branch protection")
    page.locator("#create-branch").check()
    branch = f"drafts/browser-{uuid4().hex}"
    page.locator("#new-branch").fill(branch)
    page.get_by_role("button", name="Review destination").click()
    expect(page.locator("#destination-summary")).to_contain_text("(new branch)")
    page.locator("#confirm-save").click()
    expect(page.locator("#feedback")).to_contain_text("Saved to GitHub")
    expect(page.locator("#branch")).to_have_value(branch)


def test_sign_out_and_account_switch_clear_selection(page):
    login(page)
    select_repo(page)
    page.get_by_role("button", name="Sign out", exact=True).click()
    login(page, "other-author")
    expect(page.locator("#branch-fields")).to_be_hidden()
    expect(page.locator("#review")).to_be_disabled()


def test_offline_authoring_and_download(page):
    page.context.set_offline(True)
    page.locator("#content").fill("# Offline work survives")
    expect(page.locator("#local-status")).to_have_text("Saved in this browser")
    with page.expect_download() as download:
        page.get_by_role("button", name="Download .md").click()
    assert Path(download.value.path()).read_text() == "# Offline work survives"
    page.context.set_offline(False)
    page.reload()
    expect(page.locator("#content")).to_have_value("# Offline work survives")


def test_local_storage_failure_prevents_login_navigation(page):
    page.evaluate("() => { Storage.prototype.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); }; }")
    page.get_by_role("button", name="Sign in with GitHub").click()
    expect(page.locator("#feedback")).to_contain_text("Download it before signing in")
    expect(page.locator("#content")).to_be_visible()


def test_expired_session_returns_to_local_authoring(page):
    login(page)
    page.route("**/api/github/repos*", lambda route: route.fulfill(status=401, content_type="application/json", body=json.dumps({"error":{"code":"signed_out", "message":"Your session expired. Sign in again."}})))
    page.get_by_role("button", name="Refresh", exact=True).click()
    expect(page.locator("#signed-out")).to_be_visible()
    expect(page.locator("#feedback")).to_contain_text("expired")


def test_mobile_layout_has_no_horizontal_overflow(page):
    page.set_viewport_size({"width":390,"height":844})
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    login(page)
    select_repo(page)
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")


def test_integrated_editor_private_bookmarklet_login_and_save(page, server):
    # Anonymous access fails; the authenticated service has this fixture file.
    page.route("https://api.github.com/**", lambda route: route.fulfill(status=404, content_type="application/json", body="{}"))
    page.goto(server + "/editor/?repo=demo-author/field-notes&branch=main&open=_posts/existing.md")
    expect(page.locator("#sync-sign-in")).to_be_visible(timeout=60000)
    page.locator("#sync-sign-in").click()
    page.get_by_role("link", name="Continue as demo-author").click()
    expect(page.locator("#sync-auth-status")).to_have_text("Signed in as @demo-author", timeout=60000)
    expect(page.locator("#sync-repositories")).to_have_value("1")
    expect(page.locator("#sync-branch")).to_have_value("main")
    expect(page.locator("#sync-path")).to_have_value("_posts/existing.md")
    original = page.evaluate("""async () => {
      const app = await import('/editor/app.js');
      const docs = await app.modules.store.docs.list();
      return docs.find(d => d.path === '_posts/existing.md');
    }""")
    assert original["github"]["sha"]
    page.locator("#sync-done-btn").click()
    page.locator(".cm-content").first.click()
    page.keyboard.press("ControlOrMeta+End")
    page.keyboard.type("\nLocal bookmarklet edit.")
    expect(page.locator(".cm-content").first).to_contain_text("Local bookmarklet edit.")
    page.wait_for_timeout(2500)
    # Reload proves local content and binding survive before a save.
    page.wait_for_function("""async () => {
      const app = await import('/editor/app.js');
      return (await app.modules.store.docs.list()).some(d => d.content.includes('Local bookmarklet edit.'));
    }""")
    page.reload()
    page.evaluate("""async () => { const app = await import('/editor/app.js'); app.openSyncPanel(); }""")
    expect(page.locator("#sync-repositories")).to_have_value("1", timeout=30000)
    page.locator("#sync-commit-btn").click()
    expect(page.locator("#sync-result")).to_contain_text("Committed", timeout=30000)
    assert page.locator("#sync-token-input").count() == 0
    page.locator("#sync-sign-out").click()
    expect(page.locator("#sync-sign-in")).to_be_visible()
    saved = page.evaluate("""async () => {
      const app = await import('/editor/app.js');
      return (await app.modules.store.docs.list()).find(d => d.path === '_posts/existing.md');
    }""")
    assert "Local bookmarklet edit." in saved["content"]
    assert saved["github"]["owner"] == "demo-author"
