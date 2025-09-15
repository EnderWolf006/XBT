"""
批量更新课程脚本

用途：
- 无需删除 UserInfo 重注册，直接批量或按条件更新课程信息。
- 复用 student.Student.getAllCourses 与 syncAllCoursesToDatabase 完成 Upsert。

运行示例（Windows cmd）：
- 更新所有用户：
  python updatecourse.py
- 仅按手机号：
  python updatecourse.py --mobile 13800138000
- 或按 uid：
  python updatecourse.py --uid 12345678
"""

import argparse
import sys
import traceback
import pymysql

from utils.aes import decodeToken
from utils.constants import POOL
from utils.log import Log
from student import Student
import student as student_module  # 用于向其注入 conn（兼容其内部的 conn.commit() 调用）


log = Log('UpdateCourse')


def get_target_users(cursor, mobile: str | None, uid: int | None):
    if mobile:
        cursor.execute("SELECT uid, name, mobile, token FROM UserInfo WHERE mobile=%s", (mobile,))
    elif uid is not None:
        cursor.execute("SELECT uid, name, mobile, token FROM UserInfo WHERE uid=%s", (uid,))
    else:
        cursor.execute("SELECT uid, name, mobile, token FROM UserInfo")
    return cursor.fetchall()


def update_user_courses(cursor, token: str):
    data = decodeToken(token)
    mobile = data['mobile']
    password = data['password']
    stu = Student(mobile, password)
    stu.syncAllCoursesToDatabase(cursor)


def main():
    parser = argparse.ArgumentParser(description='更新课程到数据库（批量或按条件）')
    parser.add_argument('--mobile', type=str, default=None, help='指定手机号，仅更新该用户')
    parser.add_argument('--uid', type=int, default=None, help='指定 uid，仅更新该用户')
    args = parser.parse_args()

    conn = None
    cursor = None
    try:
        conn = POOL.connection()
        cursor = conn.cursor(pymysql.cursors.DictCursor)

        # 兼容 student.syncAllCoursesToDatabase 内的 conn.commit()
        # 将当前连接注入到 student 模块的全局命名空间
        student_module.conn = conn

        users = get_target_users(cursor, args.mobile, args.uid)
        if not users:
            log.w('未找到需要更新的用户')
            return 0

        total = len(users)
        ok = 0
        fail = 0
        for idx, user in enumerate(users, start=1):
            try:
                uid = user.get('uid')
                name = user.get('name')
                mobile = user.get('mobile')
                log.i(f'[{idx}/{total}] 开始更新 uid={uid}, name={name}, mobile={mobile}')
                update_user_courses(cursor, user['token'])
                conn.commit()
                ok += 1
                log.s(f'[{idx}/{total}] 更新完成 uid={uid}')
            except Exception:
                conn.rollback()
                fail += 1
                log.e(f'[{idx}/{total}] 更新失败 uid={user.get("uid")}, 错误:')
                traceback.print_exc()

        log.s(f'汇总：成功 {ok} / 失败 {fail} / 总计 {total}')
        return 0 if fail == 0 else 1
    finally:
        if cursor is not None:
            try:
                cursor.close()
            except Exception:
                pass
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


if __name__ == '__main__':
    sys.exit(main())
