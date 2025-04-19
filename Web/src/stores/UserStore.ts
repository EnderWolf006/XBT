import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

interface User {
  uid: Number,
  name: String,
  avatar: String,
  mobile: Number,
  token: String,
}

export const useUserStore = defineStore('user', () => {
  const userList = ref<User[]>([])
  const currentUser = computed(() => {
    return userList.value.length > 0 ? userList.value[0] : null
  })
  const otherUserList = computed(() => {
    return userList.value.length > 1 ? userList.value.slice(1) : []
  })
  const token = computed(() => {
    return currentUser.value ? currentUser.value.token : ''
  })
  const changeCurrentUser = (uid: Number) => {
    let index = userList.value.findIndex(user => user.uid === uid)
    if (index === -1) {
      throw new Error('uid not found')
    }
    userList.value[0] = userList.value.splice(index, 1)[0]
  }
  const addUser = (user: User) => {
    userList.value.push(user)
    changeCurrentUser(user.uid)
  }
  const removeUser = (uid: Number) => {
    let index = userList.value.findIndex(user => user.uid === uid)
    if (index === -1) {
      throw new Error('uid not found')
    }
    userList.value.splice(index, 1)
    if (userList.value.length > 0) {
      changeCurrentUser(userList.value[0].uid)
    }
  }
  return {
    userList,
    currentUser,
    otherUserList,
    token,
    changeCurrentUser,
    addUser,
    removeUser
  }
})