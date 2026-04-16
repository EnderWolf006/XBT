export interface User {
  uid: number;
  name: string;
  mobile: string; // From API it's masked, but still key is 'mobile' in user response
  avatar: string;
  permission: number;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

export interface WhitelistItem {
  id: number;
  uid: number;
  mobile_masked: string;
  permission: number;
}

export interface Course {
  class_id: number;
  course_id: number;
  name: string;
  teacher: string;
  icon: string;
  is_selected: boolean;
}

export interface SignActivity {
  active_id: number;
  activity_name: string;
  start_time: number;
  end_time: number;
  sign_type: number;
  if_refresh_ewm: boolean;
  record_source_name: string;
  record_source: number;
  record_sign_time: number;
  course_name: string;
  course_id: number;
  class_id: number;
  course_teacher: string;
}

export interface CourseActivities {
  course_id: number;
  class_id: number;
  course_name: string;
  course_teacher: string;
  icon: string;
  has_more: boolean;
  activities: SignActivity[];
}

export interface Classmate {
  uid: number;
  name: string;
  mobile_masked: string;
  avatar: string;
}

export interface SignParams {
  activity_id: number;
  user_ids: number[];
  sign_type: number;
  course_id: number;
  class_id: number;
  if_refresh_ewm: boolean;
  special_params: Record<string, any>;
}

export interface SignStatusMessage {
  type: 'sign_status';
  activity_id: number;
  user_id: number;
  status: 'pending' | 'signing' | 'retrying' | 'success' | 'failed';
  attempt: number;
  message: string;
}

export interface SignCheckItem {
  user_id: number;
  signed: boolean;
  record_source: number;
  record_source_name: string;
  message: string;
}
