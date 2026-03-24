export const getZeroOclockOfDay = (dateTime: Date) => {
  return new Date(dateTime.getFullYear(), dateTime.getMonth(), dateTime.getDate());
};

export const padLeft = (num: number, length = 2, fill = '0') => {
  return num.toString().padStart(length, fill);
};

export const formatFullDateTime = (date: Date | number) => {
  const d = typeof date === 'number' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '无效时间';
  
  return `${d.getFullYear()}-${padLeft(d.getMonth() + 1)}-${padLeft(d.getDate())} ${padLeft(d.getHours())}:${padLeft(d.getMinutes())}:${padLeft(d.getSeconds())}`;
};

export const getChineseStringByDatetime = (date: Date | number, nowInput: Date | null = null) => {
  const dateTime = typeof date === 'number' ? new Date(date) : date;
  
  // 确保输入是有效的日期对象
  if (isNaN(dateTime.getTime())) {
    return '无效时间';
  }

  const now = nowInput ?? new Date();

  const isSameDay = dateTime.getFullYear() === now.getFullYear() &&
    dateTime.getMonth() === now.getMonth() &&
    dateTime.getDate() === now.getDate();

  if (isSameDay) {
    // Same day
    const min = Math.floor((now.getTime() - dateTime.getTime()) / (1000 * 60));

    if (min <= 1) return '刚刚';
    if (min < 60) return `${min}分钟前`;
    return `${now.getHours() - dateTime.getHours()}小时前`;
  }

  // Different day
  const dayDiff = Math.floor(
    (getZeroOclockOfDay(now).getTime() - getZeroOclockOfDay(dateTime).getTime()) / (1000 * 60 * 60 * 24)
  );

  if (dayDiff < 0) return '未来(请检查本机系统时间)';
  if (dayDiff === 1) return `昨天${padLeft(dateTime.getHours())}:${padLeft(dateTime.getMinutes())}`;
  if (dayDiff === 2) return `前天${padLeft(dateTime.getHours())}:${padLeft(dateTime.getMinutes())}`;
  if (dayDiff <= 7) return `${dayDiff}天前`;

  // Full date format
  return `${dateTime.getFullYear()}-${padLeft(dateTime.getMonth() + 1)}-${padLeft(dateTime.getDate())}`;
};
