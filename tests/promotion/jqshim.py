import json
import sys

# A stand-in for the three jq calls the report step makes, for machines without jq.
a = sys.argv[1:]
if a[:1] == ["-n"]:
    args = {}
    i = 1
    while i < len(a) and a[i] in ("--arg", "--rawfile"):
        if a[i] == "--arg":
            args[a[i + 1]] = a[i + 2]
        else:
            args[a[i + 1]] = open(a[i + 2], encoding="utf-8").read()
        i += 3
    print(json.dumps({"item_id": args["item"], "body": args["body"], "client_visible": False, "author_email": "github-actions"}))
elif a[:1] == ["-e"] and a[1] == ".[0].id":
    d = json.load(sys.stdin)
    sys.exit(0 if isinstance(d, list) and d and d[0].get("id") else 1)
elif a[:1] == ["-r"] and a[1] == ".body":
    print(json.load(open(a[2], encoding="utf-8"))["body"])
else:
    sys.exit("jq shim: unsupported " + " ".join(a))
