import sys

path = "artifacts/api-server/src/lib/daySheet.test.ts"
with open(path) as f:
    content = f.read()

old = '      confirmationCode: "ABC123",\n      type: "flight",\n    });'
new = '      confirmationCode: "ABC123",\n      type: "flight",\n      description: "notes",\n      photoUrl: null,\n    });'

count = content.count(old)
if count != 1:
    print(f"FAIL: found {count} occurrences (expected 1)")
    idx = content.find('ABC123')
    print("CONTEXT:", repr(content[max(0, idx-200):idx+300]))
    sys.exit(1)

content = content.replace(old, new)
with open(path, "w") as f:
    f.write(content)
print("OK: daySheet.test.ts toEqual updated")
