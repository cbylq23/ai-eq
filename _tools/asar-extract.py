# -*- coding: utf-8 -*-
"""读取 Electron app.asar：列出目录、抽取需要的文件。仅用于本地检查已安装 Folia 的模组校验代码。"""
import json
import os
import struct
import sys

ASAR = r"C:\Users\Administrator\AppData\Local\Programs\Folia\resources\app.asar"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_ref", "asar")


def read_header(path):
    with open(path, "rb") as handle:
        head = handle.read(8)
        size1, size2 = struct.unpack("<II", head)
        assert size1 == 4, size1
        payload = handle.read(size2)
        data_offset = 8 + size2
    # Chromium pickle: payload size(4) + string length(4) + json
    _payload_size = struct.unpack("<I", payload[0:4])[0]
    string_len = struct.unpack("<I", payload[4:8])[0]
    json_bytes = payload[8:8 + string_len]
    return json.loads(json_bytes.decode("utf-8")), data_offset


def walk(node, prefix=""):
    for name, info in node.get("files", {}).items():
        path = f"{prefix}/{name}" if prefix else name
        if "files" in info:
            yield from walk(info, path)
        else:
            yield path, info


def extract(header, data_offset, wanted, source):
    with open(source, "rb") as handle:
        for path, info in walk(header):
            if not any(path == w or path.startswith(w.rstrip("/") + "/") for w in wanted):
                continue
            target = os.path.join(OUT, *path.split("/"))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            handle.seek(data_offset + int(info["offset"]))
            data = handle.read(int(info["size"]))
            with open(target, "wb") as out:
                out.write(data)
            print(f"{len(data):>9}  {path}")


def main():
    header, data_offset = read_header(ASAR)
    if len(sys.argv) > 1 and sys.argv[1] == "list":
        prefix = sys.argv[2] if len(sys.argv) > 2 else ""
        for path, info in walk(header):
            if path.startswith(prefix):
                print(f'{info.get("size", 0):>9}  {path}')
        return
    wanted = sys.argv[1:] or ["electron/modSystem", "package.json", "src/mods/folium"]
    extract(header, data_offset, wanted, ASAR)
    print("extracted to", OUT)


if __name__ == "__main__":
    main()
