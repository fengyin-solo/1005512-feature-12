import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { backfillCleanroomConclusions } from './api/water-service'
import './styles/global.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')

// 启动时把已出结论的水系统记录幂等反映到洁净区环境监测清单。
backfillCleanroomConclusions()
