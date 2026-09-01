"""HTTP wrapper: POST report JSON -> the clinical PDF (application/pdf).

Runs on Cloud Run with IAM auth (deploy WITHOUT --allow-unauthenticated);
analyze-lisp-speech calls it with a Google-signed ID token, so there is no
shared secret to manage. Body:
  { name, date, gri, categories, result, age_group, uid }
— the exact shapes gcp-function-lisp already persists to lisp-users.
"""
import os
import tempfile
import traceback

from flask import Flask, request, send_file, jsonify

import report

app = Flask(__name__)


@app.get("/healthz")
def healthz():
    return "ok", 200


@app.post("/")
def render():
    d = request.get_json(silent=True) or {}
    try:
        out = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False).name
        report.build_report(
            name=d.get("name") or "Patient",
            date_str=d.get("date") or "",
            gri=d.get("gri"),
            categories=d.get("categories") or [],
            result_md=d.get("result") or "",
            out_path=out,
            age_group=d.get("age_group"),
            uid=d.get("uid"),
        )
        return send_file(out, mimetype="application/pdf")
    except Exception as e:
        traceback.print_exc()
        return jsonify(error=str(e)), 500


if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", 8082)))
