import sys

def edit(path, old, new, name):
    with open(path) as f:
        content = f.read()
    count = content.count(old)
    if count != 1:
        print(f"FAIL: {name}: found {count} occurrences (expected 1)")
        sys.exit(1)
    content = content.replace(old, new)
    with open(path, "w") as f:
        f.write(content)
    print(f"OK: {name}")

edit(
    "artifacts/api-server/src/lib/daySheet.ts",
    "  confirmationCode: string | null;\n  type: string;\n}",
    "  confirmationCode: string | null;\n  type: string;\n  description?: string | null;\n  photoUrl?: string | null;\n}",
    "DaySheetItem fields",
)

edit(
    "artifacts/api-server/src/lib/daySheet.ts",
    "  dayNotes: string | null;\n  weather: WeatherSnapshot | null;\n}",
    "  dayNotes: string | null;\n  weather: WeatherSnapshot | null;\n  heroPhotoUrl?: string | null;\n}",
    "DaySheet.heroPhotoUrl",
)

edit(
    "artifacts/api-server/src/lib/daySheet.ts",
    "    confirmationCode: event.confirmationCode,\n    type: event.type,\n  };",
    "    confirmationCode: event.confirmationCode,\n    type: event.type,\n    description: event.description ?? null,\n    photoUrl: event.imageUrl ?? null,\n  };",
    "timelineEventToItem mapping",
)

edit(
    "artifacts/api-server/src/lib/daySheet.ts",
    "    // The scheduler fills this in later \u2014 never fetched here.\n    weather: null,\n  };",
    "    // The scheduler fills this in later \u2014 never fetched here.\n    weather: null,\n    heroPhotoUrl:\n      trip.coverImage ?? items.find(i => i.photoUrl)?.photoUrl ?? null,\n  };",
    "buildDaySheet heroPhotoUrl",
)

edit(
    "artifacts/api-server/src/lib/daySheet.test.ts",
    '  ).toEqual({\n    time: "18:45",\n    title: "Lufthansa LH401: JFK \u2192 FRA",\n    location: "JFK",\n    confirmationCode: "ABC123",\n    type: "flight",\n  });',
    '  ).toEqual({\n    time: "18:45",\n    title: "Lufthansa LH401: JFK \u2192 FRA",\n    location: "JFK",\n    confirmationCode: "ABC123",\n    type: "flight",\n    description: "notes",\n    photoUrl: null,\n  });',
    "daySheet.test.ts toEqual",
)

print("ALL EDITS DONE")
