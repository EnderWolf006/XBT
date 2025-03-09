import requests
import json
from utils.aes import EncryptXXTByAes
from pyquery import PyQuery as pq
from utils.constants import *
from utils.log import *
from urllib import parse
import time
import pymysql
from bs4 import BeautifulSoup
import urllib.parse
import re

class Student:
  # mobile -> Student 保证一个手机号只有一个实例(避免重复登录)
  students = {}

  @staticmethod
  def preLogin(mobile, password) -> requests.cookies.RequestsCookieJar:
    data = {
      "fid": "-1",
      "uname": EncryptXXTByAes(mobile, transferKey),
      "password": EncryptXXTByAes(password, transferKey),
      "refer": "https://i.chaoxing.com",
      "t": "true",
      "forbidotherlogin": "0",
      "validate": "",
      "doubleFactorLogin": "0",
      "independentId": "0",
      "independentNameId": "0"
    }
    resp = requests.post("https://passport2.chaoxing.com/fanyalogin", params=data, headers=webFormHeaders, verify=False)
    suc = resp.json()['status']
    if not suc: 
      raise Exception("登录失败")
    resp2 = requests.get("http://i.chaoxing.com/base", cookies=resp.cookies, headers=webFormHeaders, verify=False)
    name = resp2.text.split('<p class="user-name">')[1].split('</p>')[0]
    avatar = resp2.text.split('<img class="icon-head" src="')[1].split('">')[0]
    return {
      'cookie':resp.cookies,
      'uid': int(resp.cookies.get_dict().get('UID')),
      'name': name,
      'avatar': avatar
    }
  
  def __new__(cls, *args, **kwargs):
    # 单手机号单例
    mobile = args[0]
    if mobile in Student.students:
      return Student.students[mobile]
    return super().__new__(cls)


  def __init__(self, mobile: str, password: str):
    if hasattr(self, "_inited"): # 避免重复初始化
      return
    self._inited = True
    self.uid = 0
    self.name = ''
    self.avatar = ''
    self.mobile = mobile
    self.password = password
    self.log = Log(self.name)
    self.cookieJar = None
    self.cookieJarUpdatedTime = 0
    self.login()
  
  def login(self):
    data = Student.preLogin(self.mobile, self.password)
    self.name = data['name']
    self.avatar = data['avatar']
    self.uid = data['uid']
    self.cookieJar = data['cookie']
    self.cookieJarUpdatedTime = time.time()

  def getCookieJar(self) -> requests.cookies.RequestsCookieJar:
    # 每日刷新
    if time.time() - self.cookieJarUpdatedTime > 60 * 60 * 24:
      self.login()
      self.log.i("过期cookie刷新成功")
    return self.cookieJar
  
  def syncAllCoursesToDatabase(self, cursor):
    courses = self.getAllCourses()
    for course in courses:
      cursor.execute(
      "INSERT INTO CourseInfo (name, teacher, courseId, classId, icon) VALUES (%s, %s, %s, %s, %s)"
      "ON DUPLICATE KEY UPDATE name=VALUES(name), teacher=VALUES(teacher), icon=VALUES(icon)",
      (course['name'], course['teacher'], course['courseId'], course['classId'], course['icon'])
      )
      cursor.execute("INSERT IGNORE INTO UserCourse (uid, courseId, classId, isSelected) VALUES (%s, %s, %s, %s)", (self.uid, course['courseId'], course['classId'], False))
      
  def getAllCoursesFromDatabase(self, cursor) -> list:
    cursor.execute("SELECT CourseInfo.classId, CourseInfo.courseId, CourseInfo.name, CourseInfo.teacher, CourseInfo.icon, UserCourse.isSelected FROM UserCourse JOIN CourseInfo ON UserCourse.courseId = CourseInfo.courseId AND UserCourse.classId = CourseInfo.classId WHERE UserCourse.uid = %s", (self.uid,))
    return cursor.fetchall()
  
  def getSelectedCoursesFromDatabase(self, cursor) -> list:
    cursor.execute("SELECT CourseInfo.classId, CourseInfo.courseId, CourseInfo.name, CourseInfo.teacher, CourseInfo.icon, UserCourse.isSelected FROM UserCourse JOIN CourseInfo ON UserCourse.courseId = CourseInfo.courseId AND UserCourse.classId = CourseInfo.classId WHERE UserCourse.uid = %s AND UserCourse.isSelected = 1", (self.uid,))
    return cursor.fetchall()
  
  def getAllCourses(self) -> list: 
    courses = []
    params = {
      "view": "json",
      "getTchClazzType": 1,
      "mcode": ""
    }
    # 发起请求获取课程数据
    resp = requests.get("https://mooc1-api.chaoxing.com/mycourse/backclazzdata", params=params, headers=webFormHeaders, cookies=self.getCookieJar().get_dict(), verify=False).json()
    for channel in resp["channelList"]:
      # 检查是否为有效的课程项
      if 'content' not in channel or not isinstance(channel['content'], dict):
        continue
      # 检查是否为文件夹项
      if 'folderName' in channel['content']:
        continue
      # 检查是否有roletype字段
      if 'roletype' not in channel['content']:
        continue
      # 检查roletype是否为1
      if channel['content']['roletype'] == 1:
        continue
      # 检查是否有course字段和data数组
      if 'course' not in channel['content'] or 'data' not in channel['content']['course']:
        continue
        
      for c in channel['content']['course']['data']:
        url = parse.urlparse(c['courseSquareUrl'])
        par = parse.parse_qs(url.query)
        courses.append({
          "teacher": c['teacherfactor'],
          "name": c['name'],
          "courseId": par['courseId'][0],
          "classId": par['classId'][0],
          "icon": c['imageurl'],
        })
    # 去重（移到循环外，避免重复操作）
    courses = [dict(t) for t in set([tuple(d.items()) for d in courses])]  
    return courses

  def getActivesFromCourse(self, cursor, courses: dict) -> list:
    # 拆分一个Actives一个ActivesDetail 为节流频繁请求detail
    actives = []
    params = {
      "courseId": courses['courseId'],
      "classId": courses['classId'],
    }
    resp = requests.get("https://mobilelearn.chaoxing.com/ppt/activeAPI/taskactivelist", params=params, headers=mobileHeader, cookies=self.getCookieJar().get_dict(), verify=False).json()
    for active in resp['activeList'][:getActivesLimit]: 
      if (active['activeType'] != ActivityTypeEnum.Sign.value): # 目前只支持签到
        continue
      actives.append({
        "name": active['nameOne'],
        "activeId": active['id'],
      })
    return actives

  def getActiveDetail(self, cursor, activeId):
    params = {
      "activePrimaryId": activeId,
      "type": 1
    }
    signRecord = {}
    cursor.execute("SELECT source, signTime FROM SignRecord WHERE activeId = %s AND uid = %s", (activeId, self.uid))
    if cursor.rowcount > 0:
      data = cursor.fetchone()
      source = data['source']
      signTime = data['signTime']
      cursor.execute("SELECT name FROM UserInfo WHERE uid = %s", (source))
      signRecord = {
        "source": 'self' if source == self.uid else 'agent' ,
        "sourceName": cursor.fetchone()['name'],
        "signTime": signTime,
      }
    else:
      signRecord = {
        "source": 'none',
        "sourceName": "未签到",
        "signTime": -1,
      }
    # 这里为高频请求，先从数据库查有没有缓存
    cursor.execute("SELECT activeId, startTime, endTime, signType, ifRefreshEwm FROM SignInfo WHERE activeId = %s", (activeId))
    if cursor.rowcount > 0:
      data = cursor.fetchone()
      detail = {
        "startTime": data['startTime'],
        "endTime": data['endTime'],
        "signType": data['signType'],
        "ifRefreshEwm": bool(data['ifRefreshEwm']),
        "signRecord": signRecord,
        "uid": self.uid # 向下兼容
      }
      return detail
    resp = requests.get("https://mobilelearn.chaoxing.com/newsign/signDetail", params=params, headers=mobileHeader, cookies=self.getCookieJar().get_dict(), verify=False).json()    
    detail = {
      "startTime": int(resp['startTime']['time']),
      "endTime": int(resp['endTime']['time']),
      "signType": int(resp['otherId']),
      "ifRefreshEwm": bool(resp['ifRefreshEwm']),
      "signRecord": signRecord,
      "uid": self.uid # 向下兼容
    }
    cursor.execute("INSERT IGNORE INTO SignInfo (activeId, startTime, endTime, signType, ifRefreshEwm) VALUES (%s, %s, %s, %s, %s)", (activeId, detail['startTime'], detail['endTime'], detail['signType'], detail['ifRefreshEwm']))
    return detail
  
  def getClassmates(self, cursor, classId, courseId):
    cursor.execute("SELECT uid, name, mobile, avatar FROM UserInfo WHERE uid in (SELECT uid FROM UserCourse WHERE courseId = %s AND classId = %s AND uid != %s AND isSelected = 1)", (courseId, classId, self.uid))
    return cursor.fetchall()


  def setCourseSelectState(self, cursor, courses: list):
    for course in courses:
      cursor.execute("UPDATE UserCourse SET isSelected = %s WHERE uid = %s AND courseId = %s AND classId = %s", (course['isSelected'], self.uid, course['courseId'], course['classId']))


  # 参考于kuizuo大佬的项目(目前貌似不维护了)
  # https://github.com/kuizuo/chaoxing-sign
  def preSign(self, fixedParams: dict, code=None, enc=None):
    # First request (equivalent to preSign GET request)
    params = {
      'courseId': fixedParams.get('courseId', ''),
      'classId': fixedParams.get('classId'),
      'activePrimaryId': fixedParams.get('activeId'),
      'general': '1',
      'sys': '1',
      'ls': '1',
      'appType': '15',
      'uid': fixedParams.get('uid'),  # Assuming uid comes from user object in activity
      'isTeacherViewOpen': 0
    }
    
    # Add rcode if ifRefreshEwm is True
    if fixedParams.get('ifRefreshEwm'):
        rcode = f"SIGNIN:aid={fixedParams.get('activeId')}&source=15&Code={code}&enc={enc}"
        params['rcode'] = urllib.parse.quote(rcode)

    response = requests.get('https://mobilelearn.chaoxing.com/newsign/preSign', 
                          params=params, cookies=self.getCookieJar().get_dict(), headers=mobileHeader)
    html = response.text
    
    
    # Sleep for 500ms
    # time.sleep(0.5)
    
    # Second request (analysis)
    analysis_params = {
        'vs': 1,
        'DB_STRATEGY': 'RANDOM',
        'aid': fixedParams.get('activeId')
    }
    analysis_response = requests.get('https://mobilelearn.chaoxing.com/pptSign/analysis', params=analysis_params, cookies=self.getCookieJar().get_dict(), headers=mobileHeader)
    data = analysis_response.text
    
    # Extract code using regex
    code_match = re.search(r"code='\+'(.*?)'", data)
    code = code_match.group(1) if code_match else None
    # Third request (analysis2)
    analysis2_params = {
        'DB_STRATEGY': 'RANDOM',
        'code': code
    }
    requests.get('https://mobilelearn.chaoxing.com/pptSign/analysis2', params=analysis2_params, cookies=self.getCookieJar().get_dict(), headers=mobileHeader)
    # time.sleep(0.2)
    soup = BeautifulSoup(html, 'html.parser')
    status = soup.select_one('#statuscontent')
    status_text = ''
    if status:
        status_text = re.sub(r'[\n\s]', '', status.get_text().strip())
    self.log.i("预签到状态: "+ status_text)
    if status_text:
        return status_text
    
  def sign(self, signType, fixedParams, specialParams):
    params = {}
    if signType == SignTypeEnum.Normal.value:
      params = self.signNormal(fixedParams, specialParams)
    elif signType == SignTypeEnum.QRCode.value:
      params = self.signQRCode(fixedParams, specialParams)
    elif signType == SignTypeEnum.Gesture.value:
      params = self.signGesture(fixedParams, specialParams)
    elif signType == SignTypeEnum.Location.value:
      params = self.signLocation(fixedParams, specialParams)
    elif signType == SignTypeEnum.Code.value:
      params = self.signCode(fixedParams, specialParams)
    resp = requests.get('https://mobilelearn.chaoxing.com/pptSign/stuSignajax', params=params, cookies=self.getCookieJar().get_dict(), headers=mobileHeader)
    return resp.text

  def signNormal(self, fixedParams, specialParams):
    params = {
      'activeId': fixedParams['activeId'],
      'uid': fixedParams['uid'],
      'clientip': '',
      'latitude': '-1',
      'longitude': '-1',
      'appType': '15',
      'fid': '',
      'name': self.name,
    }
    return params

  def signQRCode(self, fixedParams, specialParams):
    params = {
      'enc': specialParams['enc'],
      'name': self.name,
      'activeId': fixedParams['activeId'],
      'uid': fixedParams['uid'],
      'clientip': '',
      'useragent': '',
      'latitude': '-1',
      'longitude': '-1',
      'fid': '',
      'appType': '15',
    }
    return params

  def signGesture(self, fixedParams, specialParams):
    resp = requests.get('https://mobilelearn.chaoxing.com/widget/sign/pcStuSignController/checkSignCode',
                                    params={"activeId": fixedParams['activeId'], "signCode": specialParams['signCode']}, cookies=self.getCookieJar().get_dict(), headers=mobileHeader).json()
    if (resp['result'] != 1):
      raise Exception(resp['errorMsg']) 
    params = {
      'activeId': fixedParams['activeId'],
      'uid': fixedParams['uid'],
      'clientip': '',
      'latitude': '',
      'longitude': '',
      'appType': '15',
      'fid': '',
      'name': self.name,
      'signCode': specialParams['signCode'],
    }
    return params

  def signLocation(self, fixedParams, specialParams):
    params = {
      'activeId': fixedParams['activeId'],
      'address': specialParams['description'],
      'uid': fixedParams['uid'],
      'clientip': '',
      'latitude': specialParams['latitude'],
      'longitude': specialParams['longitude'],
      'appType': '15',
      'fid': '',
      'name': self.name,
      'ifTiJiao': 1,
      'validate': '',
    }
    return params

  def signCode(self, fixedParams, specialParams):
    params = {
      'activeId': fixedParams['activeId'],
      'uid': fixedParams['uid'],
      'clientip': '',
      'latitude': '',
      'longitude': '',
      'appType': '15',
      'fid': '',
      'name': self.name,
      'signCode': specialParams['signCode'],
    }
    return params

  def signPicture(self, fixedParams, specialParams):
    pass

  def getSignStateFromDataBase(self, cursor, activeId, classmates):
    classmates = [self.uid] + classmates
    result = {}
    for uid in classmates:
      cursor.execute("SELECT uid FROM SignRecord WHERE activeId = %s AND uid = %s" % (activeId, uid))
      result[uid] = cursor.rowcount > 0
    return result