#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""课时工资记录 · 本地服务端

仅使用 Python 标准库（http.server + sqlite3），无需安装任何第三方依赖。
数据保存在与本脚本同目录的 data.db —— 这是一个真正的 SQLite 文件，
可用任意 SQLite 工具打开、复制即备份，清浏览器缓存也不会丢。

运行：
    python3 server.py            # 默认 http://localhost:8000
    python3 server.py 8080       # 指定端口
    NO_BROWSER=1 python3 server.py   # 启动时不自动打开浏览器
"""
import os
import sys
import json
import time
import datetime
import base64
import struct
import zlib
import hmac
import hashlib
import secrets
import sqlite3
import socket
import threading
import webbrowser
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, 'data.db')

# 仅允许访问这些静态文件（避免泄露 server.py / data.db 等）
STATIC_FILES = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/app.js': 'app.js',
    '/styles.css': 'styles.css',
    '/manifest.webmanifest': 'manifest.webmanifest',
    '/icon.svg': 'icon.svg',
}

VALID_TOKENS = set()
_tokens_lock = threading.Lock()


# ---------- 数据库 ----------
def db():
    conn = sqlite3.connect(DB_PATH, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA busy_timeout=4000')
    conn.execute('PRAGMA foreign_keys=ON')
    return conn


def init_db():
    conn = db()
    conn.executescript('''
    CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
    );
    CREATE TABLE IF NOT EXISTS students (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        note TEXT DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        start_time TEXT DEFAULT '',
        course_type TEXT NOT NULL,
        extra INTEGER NOT NULL DEFAULT 0,
        amount REAL NOT NULL DEFAULT 0,
        note TEXT DEFAULT '',
        created_at INTEGER,
        updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS attendance (
        session_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        name TEXT,
        PRIMARY KEY (session_id, student_id)
    );
    CREATE TABLE IF NOT EXISTS photos (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        w INTEGER,
        h INTEGER,
        mime TEXT,
        data BLOB,
        created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date);
    CREATE INDEX IF NOT EXISTS idx_att_session ON attendance(session_id);
    CREATE INDEX IF NOT EXISTS idx_photos_session ON photos(session_id);
    ''')
    # 迁移：为旧库补上 start_time 列
    cols = [r[1] for r in conn.execute('PRAGMA table_info(sessions)').fetchall()]
    if 'start_time' not in cols:
        conn.execute("ALTER TABLE sessions ADD COLUMN start_time TEXT DEFAULT ''")
    if conn.execute("SELECT 1 FROM meta WHERE key='settings'").fetchone() is None:
        conn.execute("INSERT INTO meta(key, value) VALUES('settings', ?)",
                     (json.dumps({'rates': {'cpp': 30, 'python': 25}, 'schoolMin': 100}),))
    conn.commit()
    conn.close()


# ---------- 工具 ----------
def num(v, default=0):
    try:
        if v is None or v == '':
            return default
        return float(v)
    except (ValueError, TypeError):
        return default


def new_id():
    return 'id-' + secrets.token_hex(8)


def now_ms():
    return int(time.time() * 1000)


def get_meta(conn, key):
    r = conn.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
    return r['value'] if r else None


def set_meta(conn, key, value):
    conn.execute(
        'INSERT INTO meta(key, value) VALUES(?, ?) '
        'ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, value))


def has_password(conn):
    return get_meta(conn, 'auth') is not None


def hash_password(pw):
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac('sha256', pw.encode('utf-8'), salt, 120000)
    return 'pbkdf2$120000$' + salt.hex() + '$' + dk.hex()


def verify_password(pw, stored):
    try:
        _algo, iters, salt_hex, hash_hex = stored.split('$')
        dk = hashlib.pbkdf2_hmac('sha256', pw.encode('utf-8'), bytes.fromhex(salt_hex), int(iters))
        return hmac.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False


# ---------- 演示数据 ----------
def _png_solid(w, h, rgb):
    """用标准库生成一张纯色 PNG（演示照片，无需第三方依赖）。"""
    def chunk(typ, data):
        return (struct.pack('>I', len(data)) + typ + data
                + struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff))
    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)  # 8 位、RGB
    row = b'\x00' + bytes(rgb) * w
    idat = zlib.compress(row * h, 9)
    return sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')


def seed_demo(conn):
    """清空并写入一组演示数据（学员、课程、照片），用于体验。"""
    conn.executescript('DELETE FROM photos; DELETE FROM attendance; DELETE FROM sessions; DELETE FROM students;')
    names = ['王小明', '李华', '张伟', '刘洋', '陈晨', '赵雷', '孙悦', '周杰']
    sids = {}
    base = now_ms()
    for i, n in enumerate(names):
        sid = new_id()
        sids[n] = sid
        conn.execute('INSERT INTO students(id,name,note,active,created_at) VALUES(?,?,?,1,?)', (sid, n, '', base + i))
    today = datetime.date.today()
    # (距今天数, 课程, 出勤名单, 不记名人数, 入校金额, 备注, 照片颜色列表)
    plan = [
        (0,  'cpp',    ['王小明', '李华', '张伟', '刘洋', '陈晨'], 0, 0, 'C++ 第9讲：结构体', [(37, 99, 235)]),
        (0,  'python', ['赵雷', '孙悦', '周杰'], 0, 0, 'Python 文件操作', []),
        (1,  'cpp',    ['王小明', '李华', '张伟', '刘洋'], 0, 0, 'C++ 第8讲：指针与数组', [(37, 99, 235), (16, 150, 90)]),
        (3,  'python', ['陈晨', '赵雷', '孙悦'], 0, 0, 'Python 爬虫入门', []),
        (5,  'school', [], 0, 200, '第三实验小学 编程社团', [(217, 119, 6)]),
        (8,  'cpp',    ['王小明', '李华', '刘洋', '周杰', '陈晨'], 0, 0, 'C++ 第7讲：函数', []),
        (12, 'python', ['张伟', '孙悦', '周杰'], 1, 0, 'Python 列表与字典', []),
        (15, 'school', [], 0, 150, '阳光中学 入校课', []),
        (18, 'cpp',    ['王小明', '李华', '张伟'], 0, 0, 'C++ 第6讲：循环', []),
        (22, 'python', ['陈晨', '赵雷', '孙悦', '刘洋'], 0, 0, 'Python 函数与模块', [(124, 58, 237)]),
        (26, 'cpp',    ['王小明', '周杰'], 2, 0, 'C++ 一对二补课', []),
        (33, 'school', [], 0, 300, '第三实验小学 公开课', []),
        (38, 'python', ['李华', '张伟', '孙悦'], 0, 0, 'Python 基础语法', []),
        (45, 'cpp',    ['王小明', '李华', '张伟', '刘洋', '陈晨', '赵雷'], 0, 0, 'C++ 第5讲：变量与类型', []),
    ]
    ts = now_ms()
    clock = {'cpp': '18:30:00', 'python': '20:00:00', 'school': '10:15:00'}
    for off, course, atts, extra, amount, note, colors in plan:
        sid = new_id()
        when = ts - off * 86400000
        conn.execute('INSERT INTO sessions(id,date,start_time,course_type,extra,amount,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
                     (sid, (today - datetime.timedelta(days=off)).isoformat(), clock.get(course, ''), course, extra,
                      amount if course == 'school' else 0, note, when, when))
        for n in atts:
            conn.execute('INSERT OR REPLACE INTO attendance(session_id,student_id,name) VALUES(?,?,?)', (sid, sids[n], n))
        for col in colors:
            conn.execute('INSERT INTO photos(id,session_id,w,h,mime,data,created_at) VALUES(?,?,?,?,?,?,?)',
                         (new_id(), sid, 800, 600, 'image/png', sqlite3.Binary(_png_solid(800, 600, col)), ts))
    conn.commit()


# ---------- HTTP 处理 ----------
class Handler(BaseHTTPRequestHandler):
    server_version = 'PTClass/2.0'
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (self.command, self.path))

    # ---- 响应辅助 ----
    def _write(self, data):
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self._write(data)

    def _bytes(self, data, ctype, status=200, headers=None):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self._write(data)

    def _body(self):
        try:
            n = int(self.headers.get('Content-Length', 0) or 0)
        except ValueError:
            n = 0
        if n <= 0:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode('utf-8'))
        except Exception:
            return {}

    def _authed(self, conn):
        if not has_password(conn):
            return True  # 未设密码 = 开放编辑
        h = self.headers.get('Authorization', '')
        if h.startswith('Bearer '):
            with _tokens_lock:
                return h[7:] in VALID_TOKENS
        return False

    # ---- 序列化 ----
    @staticmethod
    def _student(r):
        return {'id': r['id'], 'name': r['name'], 'note': r['note'] or '',
                'active': bool(r['active']), 'createdAt': r['created_at']}

    @staticmethod
    def _all_sessions(conn):
        att = {}
        for r in conn.execute('SELECT session_id, student_id, name FROM attendance'):
            att.setdefault(r['session_id'], []).append({'id': r['student_id'], 'name': r['name']})
        ph = {}
        for r in conn.execute('SELECT id, session_id FROM photos ORDER BY created_at'):
            ph.setdefault(r['session_id'], []).append(r['id'])
        out = []
        for s in conn.execute('SELECT * FROM sessions ORDER BY date DESC, start_time DESC, created_at DESC'):
            out.append({
                'id': s['id'], 'date': s['date'], 'time': s['start_time'] or '', 'courseType': s['course_type'],
                'extra': int(s['extra'] or 0), 'amount': s['amount'], 'note': s['note'] or '',
                'createdAt': s['created_at'], 'updatedAt': s['updated_at'],
                'attendees': att.get(s['id'], []), 'photoIds': ph.get(s['id'], []),
            })
        return out

    # ---- GET ----
    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith('/api/'):
            return self._api_get(path)
        self._static(path)

    def _static(self, path):
        fname = STATIC_FILES.get(path)
        if not fname:
            return self._bytes(b'Not Found', 'text/plain; charset=utf-8', 404)
        fpath = os.path.join(BASE_DIR, fname)
        if not os.path.isfile(fpath):
            return self._bytes(b'Not Found', 'text/plain; charset=utf-8', 404)
        ctype = mimetypes.guess_type(fpath)[0] or 'application/octet-stream'
        if fname.endswith('.webmanifest'):
            ctype = 'application/manifest+json'
        if ctype.startswith('text/') or 'javascript' in ctype or 'json' in ctype or 'svg' in ctype or 'manifest' in ctype:
            ctype += '; charset=utf-8'
        with open(fpath, 'rb') as f:
            data = f.read()
        self._bytes(data, ctype, headers={'Cache-Control': 'no-cache'})

    def _api_get(self, path):
        conn = db()
        try:
            if path == '/api/state':
                return self._json({'hasPassword': has_password(conn)})
            if path == '/api/auth/check':
                ok = self._authed(conn)
                return self._json({'ok': ok}, 200 if ok else 401)
            if path == '/api/settings':
                return self._json(json.loads(get_meta(conn, 'settings') or '{}'))
            if path == '/api/schedule':
                return self._json(json.loads(get_meta(conn, 'schedule') or '[]'))
            if path == '/api/students':
                rows = conn.execute('SELECT * FROM students').fetchall()
                return self._json([self._student(r) for r in rows])
            if path == '/api/sessions':
                return self._json(self._all_sessions(conn))
            if path.startswith('/api/photos/'):
                pid = path[len('/api/photos/'):]
                r = conn.execute('SELECT mime, data FROM photos WHERE id=?', (pid,)).fetchone()
                if not r:
                    return self._bytes(b'Not Found', 'text/plain', 404)
                return self._bytes(bytes(r['data']), r['mime'] or 'image/jpeg',
                                   headers={'Cache-Control': 'public, max-age=31536000, immutable'})
            return self._json({'error': 'not found'}, 404)
        finally:
            conn.close()

    # ---- 写操作 ----
    def do_POST(self):
        self._api_write('POST')

    def do_PUT(self):
        self._api_write('PUT')

    def do_DELETE(self):
        self._api_write('DELETE')

    def _api_write(self, method):
        path = urlparse(self.path).path
        if not path.startswith('/api/'):
            return self._json({'error': 'not found'}, 404)
        conn = db()
        try:
            # —— 登录 / 设密码（特殊处理）——
            if path == '/api/login' and method == 'POST':
                pw = self._body().get('password', '')
                stored = get_meta(conn, 'auth')
                if stored and verify_password(pw, stored):
                    tok = secrets.token_urlsafe(32)
                    with _tokens_lock:
                        VALID_TOKENS.add(tok)
                    return self._json({'token': tok})
                return self._json({'error': '密码不正确'}, 401)

            if path == '/api/password' and method == 'POST':
                b = self._body()
                stored = get_meta(conn, 'auth')
                if stored:
                    if not self._authed(conn):
                        return self._json({'error': 'unauthorized'}, 401)
                    if not verify_password(b.get('current', ''), stored):
                        return self._json({'error': '当前密码不正确'}, 400)
                new_pw = b.get('newPassword', '') or ''
                if new_pw:
                    set_meta(conn, 'auth', hash_password(new_pw))
                    conn.commit()
                    tok = secrets.token_urlsafe(32)
                    with _tokens_lock:
                        VALID_TOKENS.add(tok)
                    return self._json({'ok': True, 'hasPassword': True, 'token': tok})
                conn.execute("DELETE FROM meta WHERE key='auth'")
                conn.commit()
                with _tokens_lock:
                    VALID_TOKENS.clear()
                return self._json({'ok': True, 'hasPassword': False})

            # 下载数据库备份：若已设密码，必须在请求体提供正确密码（每次下载都要验证）
            if path == '/api/db' and method == 'POST':
                stored = get_meta(conn, 'auth')
                if stored and not verify_password(self._body().get('password', ''), stored):
                    return self._json({'error': '密码不正确'}, 401)
                try:
                    conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
                    conn.commit()
                except Exception:
                    pass
                with open(DB_PATH, 'rb') as f:
                    data = f.read()
                return self._bytes(data, 'application/octet-stream',
                                   headers={'Content-Disposition': 'attachment; filename="course-data.db"'})

            # —— 其余写操作均需鉴权 ——
            if not self._authed(conn):
                return self._json({'error': 'unauthorized'}, 401)

            # 学员
            if path == '/api/students' and method == 'POST':
                b = self._body()
                sid = new_id()
                conn.execute('INSERT INTO students(id, name, note, active, created_at) VALUES(?,?,?,1,?)',
                             (sid, (b.get('name') or '').strip(), b.get('note') or '', now_ms()))
                conn.commit()
                return self._json({'id': sid})
            if path.startswith('/api/students/'):
                sid = path[len('/api/students/'):]
                if method == 'PUT':
                    b = self._body()
                    conn.execute('UPDATE students SET name=?, note=?, active=? WHERE id=?',
                                 ((b.get('name') or '').strip(), b.get('note') or '',
                                  1 if b.get('active', True) else 0, sid))
                    conn.commit()
                    return self._json({'ok': True})
                if method == 'DELETE':
                    conn.execute('DELETE FROM students WHERE id=?', (sid,))
                    conn.commit()
                    return self._json({'ok': True})

            # 课程记录
            if path == '/api/sessions' and method == 'POST':
                return self._save_session(conn, None)
            if path.startswith('/api/sessions/'):
                rest = path[len('/api/sessions/'):]
                if rest.endswith('/photos') and method == 'POST':
                    return self._add_photo(conn, rest[:-len('/photos')])
                sid = rest
                if method == 'PUT':
                    return self._save_session(conn, sid)
                if method == 'DELETE':
                    conn.execute('DELETE FROM photos WHERE session_id=?', (sid,))
                    conn.execute('DELETE FROM attendance WHERE session_id=?', (sid,))
                    conn.execute('DELETE FROM sessions WHERE id=?', (sid,))
                    conn.commit()
                    return self._json({'ok': True})

            # 照片删除
            if path.startswith('/api/photos/') and method == 'DELETE':
                conn.execute('DELETE FROM photos WHERE id=?', (path[len('/api/photos/'):],))
                conn.commit()
                return self._json({'ok': True})

            # 设置
            if path == '/api/settings' and method == 'PUT':
                b = self._body()
                cur = json.loads(get_meta(conn, 'settings') or '{}')
                rates_in = b.get('rates') or cur.get('rates', {'cpp': 30, 'python': 25})
                settings = {
                    'rates': {
                        'cpp': int(round(num(rates_in.get('cpp'), 30))),
                        'python': int(round(num(rates_in.get('python'), 25))),
                    },
                    'schoolMin': int(round(num(b.get('schoolMin'), cur.get('schoolMin', 100)))),
                }
                set_meta(conn, 'settings', json.dumps(settings))
                conn.commit()
                return self._json(settings)

            # 课程表（每周排课，存为 meta 里的 JSON 数组）
            if path == '/api/schedule' and method == 'PUT':
                items = self._body().get('schedule') or []
                clean = []
                for it in items:
                    ct = it.get('courseType')
                    if ct not in ('cpp', 'python', 'school'):
                        ct = 'cpp'
                    clean.append({
                        'id': str(it.get('id') or new_id()),
                        'weekday': max(1, min(7, int(num(it.get('weekday'), 1)))),
                        'time': str(it.get('time') or '')[:5],
                        'courseType': ct,
                        'title': str(it.get('title') or '')[:100],
                    })
                set_meta(conn, 'schedule', json.dumps(clean))
                conn.commit()
                return self._json(clean)

            # 清空全部数据（保留密码与设置）；已设密码时需再次验证密码
            if path == '/api/reset' and method == 'POST':
                stored = get_meta(conn, 'auth')
                if stored and not verify_password(self._body().get('password', ''), stored):
                    return self._json({'error': '密码不正确'}, 401)
                conn.executescript('DELETE FROM photos; DELETE FROM attendance; '
                                   'DELETE FROM sessions; DELETE FROM students;')
                conn.commit()
                return self._json({'ok': True})

            # 载入演示数据（清空后写入示例）
            if path == '/api/demo' and method == 'POST':
                seed_demo(conn)
                return self._json({'ok': True})

            return self._json({'error': 'not found'}, 404)
        except Exception as e:
            return self._json({'error': str(e)}, 500)
        finally:
            conn.close()

    def _save_session(self, conn, sid):
        b = self._body()
        course = b.get('courseType', 'cpp')
        date = b.get('date', '')
        start_time = (b.get('time') or '')[:8]
        extra = int(round(num(b.get('extra'), 0)))
        amount = num(b.get('amount'), 0) if course == 'school' else 0
        note = b.get('note') or ''
        attendees = b.get('attendees') or []
        ts = now_ms()
        if sid is None:
            sid = new_id()
            conn.execute('INSERT INTO sessions(id, date, start_time, course_type, extra, amount, note, created_at, updated_at) '
                         'VALUES(?,?,?,?,?,?,?,?,?)', (sid, date, start_time, course, extra, amount, note, ts, ts))
        else:
            conn.execute('UPDATE sessions SET date=?, start_time=?, course_type=?, extra=?, amount=?, note=?, updated_at=? WHERE id=?',
                         (date, start_time, course, extra, amount, note, ts, sid))
        conn.execute('DELETE FROM attendance WHERE session_id=?', (sid,))
        for a in attendees:
            if a.get('id'):
                conn.execute('INSERT OR REPLACE INTO attendance(session_id, student_id, name) VALUES(?,?,?)',
                             (sid, a.get('id'), a.get('name')))
        conn.commit()
        return self._json({'id': sid})

    def _add_photo(self, conn, sid):
        b = self._body()
        data_url = b.get('dataUrl') or ''
        mime = 'image/jpeg'
        if data_url and ',' in data_url:
            head, b64 = data_url.split(',', 1)
            if head.startswith('data:') and ';' in head:
                mime = head[5:head.index(';')] or mime
        else:
            b64 = b.get('b64', '')
            mime = b.get('mime', mime)
        try:
            raw = base64.b64decode(b64)
        except Exception:
            return self._json({'error': 'bad image'}, 400)
        if not raw:
            return self._json({'error': 'empty image'}, 400)
        pid = new_id()
        conn.execute('INSERT INTO photos(id, session_id, w, h, mime, data, created_at) VALUES(?,?,?,?,?,?,?)',
                     (pid, sid, int(round(num(b.get('w'), 0))), int(round(num(b.get('h'), 0))),
                      mime, sqlite3.Binary(raw), now_ms()))
        conn.commit()
        return self._json({'id': pid})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def lan_ips():
    """探测本机的局域网 IP（供同一 Wi-Fi 下的手机访问）。"""
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))  # 不会真的发包，只为拿到出口网卡 IP
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith('127.'):
                ips.add(ip)
    except Exception:
        pass
    return sorted(ips)


def main():
    init_db()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get('PORT', '8000'))
    local_only = os.environ.get('LOCAL_ONLY') == '1'
    host = '127.0.0.1' if local_only else '0.0.0.0'
    httpd = Server((host, port), Handler)

    print('=' * 52)
    print('  课时工资记录 · 本地服务已启动')
    print('  本机访问：   http://localhost:%d' % port)
    if not local_only:
        ips = lan_ips()
        if ips:
            print('  手机访问（同一 Wi-Fi）：')
            for ip in ips:
                print('               http://%s:%d' % (ip, port))
            print('  （电脑需保持开机并运行本服务；首次可能弹出防火墙授权，请点允许）')
        else:
            print('  手机访问：未探测到局域网 IP，请确认已连接 Wi-Fi')
    else:
        print('  （仅本机模式 LOCAL_ONLY=1，手机/其他设备无法访问）')
    print('  数据库：     ' + DB_PATH)
    print('  备份：       复制 data.db 即可（或在「设置」里下载）')
    print('  停止：       按 Ctrl+C')
    print('=' * 52)

    if os.environ.get('NO_BROWSER') != '1':
        threading.Timer(0.6, lambda: webbrowser.open('http://localhost:%d' % port)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止。')
        httpd.shutdown()


if __name__ == '__main__':
    main()
