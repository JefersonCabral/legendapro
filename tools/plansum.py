import json, sys
p = json.load(open(sys.argv[1], encoding="utf-8"))
for s in p["scenes"]:
    lines = [" ".join(("*" if t["role"] == "serif" else "") + t["text"] + ("°" if t["color"] != "#FFFFFF" else "") + ("[box]" if "box" in t["fx"] else "") for t in l["tokens"]) for l in s["lines"]]
    d = ",".join(x["kind"] for x in s["decos"])
    print(f'{s["t_in"]:6.2f}-{s["t_out"]:6.2f} {s["mode"]:5} {" / ".join(lines)} {d}')
print("flashes", p["flashes"])
