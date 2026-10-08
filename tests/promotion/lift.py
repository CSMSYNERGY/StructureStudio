import sys
import yaml

d = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
out = sys.argv[2]
j = d["jobs"]
if "gate" in j:
    for jid, sid in (("gate", "merge"), ("promote", "remerge"), ("promote", "push")):
        s = [x for x in j[jid]["steps"] if x.get("id") == sid][0]
        open(f"{out}/yml-step-{jid}-{sid}.sh", "w", newline="\n", encoding="utf-8").write(s["run"])
    print("new")
else:
    s = [x for x in j["merge-beta-into-main"]["steps"] if x.get("id") == "merge"][0]
    open(f"{out}/merge-step.sh", "w", newline="\n", encoding="utf-8").write(s["run"])
    print("old")
