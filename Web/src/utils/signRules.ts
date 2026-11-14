import type { SignActivity } from '../types';

type ActivityRules = Pick<SignActivity, 'sign_type' | 'if_photo' | 'if_get_range' | 'need_face' | 'rules_verified'>;

export function describeSignRules(activity: ActivityRules): string {
  let method: string;
  switch (activity.sign_type) {
    case 0: method = activity.if_photo ? '拍照' : '普通'; break;
    case 2: method = '二维码'; break;
    case 3: method = '手势'; break;
    case 4: method = '位置'; break;
    case 5: method = '签到码'; break;
    default: method = '其他';
  }
  const rules = [method];
  if (activity.if_get_range && activity.sign_type !== 4) rules.push('位置');
  if (activity.need_face || (activity.if_photo && activity.sign_type !== 0)) rules.push('人脸');
  const description = rules.join(' + ');
  return activity.rules_verified === true ? description : `${description}（规则待核实）`;
}
