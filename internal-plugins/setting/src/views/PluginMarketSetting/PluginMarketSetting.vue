<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useToast, AdaptiveIcon } from '@/components'
import {
  compareVersions,
  shuffleArray,
  upgradeInstalledPluginFromMarket,
  weightedSearch
} from '@/utils'
import { PluginDetail, PluginCard, CategoryCard, CategoryDetail, RefreshButton } from './components'
import type { Plugin, CategoryInfo, CategoryLayoutSection } from './components'
import { useJumpFunction, useZtoolsSubInput } from '@/composables'
import { PluginMarketSettingJumpFunction } from '@/views/PluginMarketSetting/PluginMarketSetting'
import { db } from '@ztools-center/ztools-api-types'
const { success, error, confirm } = useToast()

interface BannerItem {
  image: string
  url?: string
  height?: number
}

interface CategorySummary {
  key: string
  title: string
  description?: string
  icon?: string
  showDescription: boolean
  pluginCount: number
}

interface StorefrontSection {
  type: 'banner' | 'navigation' | 'fixed' | 'random'
  key: string
  title?: string
  height?: number
  items?: BannerItem[]
  categories?: CategorySummary[]
  plugins?: Plugin[]
}

interface StorefrontCategoryPayload {
  key: string
  title: string
  description?: string
  icon?: string
  plugins: Array<{ name: string }>
}

interface StorefrontPayload {
  sections: StorefrontSection[]
  categories?: Record<string, StorefrontCategoryPayload>
  categoryLayouts?: Record<string, CategoryLayoutSection[]>
}

interface MarketPlugin extends Omit<Plugin, 'installed'> {
  platform?: string[]
}

interface InstalledPlugin {
  name: string
  path: string
  version: string
}

interface PluginMarketResponse {
  success: boolean
  data?: MarketPlugin[]
  storefront?: StorefrontPayload
  error?: string
}

const plugins = ref<Plugin[]>([])
const pluginMap = ref<Map<string, Plugin>>(new Map())
const storefrontSections = ref<StorefrontSection[]>([])
const storefrontCategories = ref<Record<string, CategoryInfo>>({})
const categoryLayouts = ref<Record<string, CategoryLayoutSection[]>>({})
const isLoading = ref(false)
const installingPlugin = ref<string | null>(null)
const activeTab = ref<'market' | 'download'>('market')
const downloadList = ref<Plugin[]>([])
// 下载队列检查定时器
let downloadQueueTimer: number | null = null

const { value: searchQuery, setSubInput } = useZtoolsSubInput('', '搜索插件市场...')

// 搜索模式：有搜索词时使用扁平搜索
const isSearchMode = computed(() => (searchQuery.value || '').trim().length > 0)

const filteredPlugins = computed(() =>
  weightedSearch(plugins.value, searchQuery.value || '', [
    { value: (p) => p.title || p.name || '', weight: 10 },
    { value: (p) => p.description || '', weight: 5 }
  ])
)

// 是否有 storefront 数据可用
const hasStorefront = computed(() => storefrontSections.value.length > 0)

// 插件详情面板状态
const isDetailVisible = ref(false)
const selectedPlugin = ref<Plugin | null>(null)

// 分类详情面板状态
const isCategoryDetailVisible = ref(false)
const selectedCategory = ref<CategoryInfo | null>(null)

// 是否显示主滚动内容（任一覆盖面板打开时隐藏）
const showScrollableContent = computed(
  () => !isDetailVisible.value && !isCategoryDetailVisible.value
)
// 将市场插件数据标记已安装状态
function enrichPlugins(
  marketPlugins: MarketPlugin[],
  installedPlugins: InstalledPlugin[],
  currentPlatform: string
): Plugin[] {
  return marketPlugins
    .filter((plugin) => {
      if (!plugin.platform || !Array.isArray(plugin.platform)) return true
      return plugin.platform.includes(currentPlatform)
    })
    .map((plugin) => {
      const installedPlugin = installedPlugins.find((item) => item.name === plugin.name)
      return {
        ...plugin,
        installed: !!installedPlugin,
        path: installedPlugin?.path,
        localVersion: installedPlugin?.version
      }
    })
}

async function fetchPlugins(): Promise<void> {
  isLoading.value = true
  try {
    const currentPlatform = window.ztools.internal.getPlatform()
    const [marketResult, installedPluginsList] = await Promise.all([
      window.ztools.internal.fetchPluginMarket(),
      window.ztools.internal.getPlugins()
    ])

    const typedInstalledPlugins = installedPluginsList as InstalledPlugin[]
    const typedMarketResult = marketResult as PluginMarketResponse

    if (typedMarketResult.success && typedMarketResult.data) {
      const marketPlugins = typedMarketResult.data

      // 构建带安装状态的插件扁平列表（用于搜索）
      plugins.value = enrichPlugins(marketPlugins, typedInstalledPlugins, currentPlatform)

      // 构建 pluginMap
      const pMap = new Map<string, Plugin>()
      for (const p of plugins.value) {
        if (p.name) pMap.set(p.name, p)
      }
      pluginMap.value = pMap

      // 构建 storefront sections
      storefrontCategories.value = {}
      categoryLayouts.value = {}

      if (typedMarketResult.storefront?.sections) {
        // 处理 categories（从后端返回的完整分类数据）
        if (typedMarketResult.storefront.categories) {
          const cats: Record<string, CategoryInfo> = {}
          for (const [key, cat] of Object.entries(typedMarketResult.storefront.categories)) {
            const categoryPlugins = cat.plugins
              .map((plugin) => pMap.get(plugin.name))
              .filter((plugin): plugin is Plugin => !!plugin)
            cats[key] = {
              key: cat.key,
              title: cat.title,
              description: cat.description,
              icon: cat.icon,
              plugins: categoryPlugins
            }
          }
          storefrontCategories.value = cats
        }

        // 处理 categoryLayouts
        if (typedMarketResult.storefront.categoryLayouts) {
          categoryLayouts.value = typedMarketResult.storefront.categoryLayouts
        }

        // 处理 sections：将 fixed/random 中的插件替换为带安装状态的版本
        storefrontSections.value = typedMarketResult.storefront.sections
          .map((section) => {
            if (
              (section.type === 'fixed' || section.type === 'random') &&
              Array.isArray(section.plugins)
            ) {
              return {
                ...section,
                plugins: section.plugins
                  .map((p) => pMap.get(p.name))
                  .filter((p): p is Plugin => !!p)
              }
            }
            return section
          })
          .filter((section) =>
            section.type === 'banner'
              ? (section.items?.length ?? 0) > 0
              : section.type === 'navigation'
                ? (section.categories?.length ?? 0) > 0
                : (section.plugins?.length ?? 0) > 0
          )
      } else {
        storefrontSections.value = []
      }
    } else {
      console.error('获取插件市场列表失败:', typedMarketResult.error)
    }
  } catch (error) {
    console.error('获取插件列表出错:', error)
  } finally {
    isLoading.value = false
  }
}

async function loadDownloadList(): Promise<void> {
  let downListRecord = db.get('downList')
  downloadList.value = JSON.parse(downListRecord?.list || '[]') as Plugin[]
  const typeInstalledPluginsList = await Promise.resolve(window.ztools.internal.getPlugins())
  downloadList.value.forEach((plugin) => {
    const installedPlugin = typeInstalledPluginsList.find((p) => p.name === plugin.name)
    if (installedPlugin) {
      plugin.status = 'installed'
      plugin.installed = true
      plugin.path = installedPlugin.path
      // console.log(`插件 ${plugin.title} 已安装，状态设置为 ${plugin.status}`)
    } else {
      plugin.installed = false
      // console.log(`插件 ${plugin.title} 未安装，状态设置为 ${plugin.status}`)
    }
  })
  if (downListRecord) {
    downListRecord.list = JSON.stringify(downloadList.value)
    db.put(downListRecord)
  } else {
    db.put({
      _id: 'downList',
      list: JSON.stringify(downloadList.value)
    })
  }
}

// 更新数据库中的插件状态
function updatePluginStatusInDb(pluginName: string, status: string, progress: number = 0): void {
  const downListRecord = db.get('downList')
  if (downListRecord) {
    const list = JSON.parse(downListRecord.list) as Plugin[]
    const plugin = list.find((p) => p.name === pluginName)
    if (plugin) {
      plugin.status = status as any
      if (status === 'installed') {
        plugin.installed = true
      } else {
        plugin.installed = false
      }
      plugin.progress = progress
      downListRecord.list = JSON.stringify(list)
      db.put(downListRecord)
      // 更新内存中的状态
      const memoryPlugin = downloadList.value.find((p) => p.name === pluginName)
      if (memoryPlugin) {
        memoryPlugin.status = status as any
        memoryPlugin.progress = progress
      }
    }
  }
}

// 重试失败的下载
async function retryFailedDownload(pluginName: string): Promise<void> {
  const installedPluginsList = await Promise.resolve(window.ztools.internal.getPlugins())
  const typedInstalledPlugins = installedPluginsList as InstalledPlugin[]
  const plugin = downloadList.value.find((p) => p.name === pluginName)
  const exsits = typedInstalledPlugins.some((p) => p.name === pluginName)
  if (!exsits && plugin) {
    plugin.errorMessage = undefined
    updatePluginStatusInDb(pluginName, 'waiting', 0)
  }
}

// 从下载列表删除
function removeFromDownloadList(pluginName: string): void {
  const index = downloadList.value.findIndex((p) => p.name === pluginName)
  if (index !== -1) {
    downloadList.value.splice(index, 1)
    const downListRecord = db.get('downList')
    if (downListRecord) {
      const list = JSON.parse(downListRecord.list) as Plugin[]
      const pluginIndex = list.findIndex((p) => p.name === pluginName)
      if (pluginIndex !== -1) {
        list.splice(pluginIndex, 1)
        downListRecord.list = JSON.stringify(list)
        db.put(downListRecord)
      }
    }
  }
}

// 检查下载队列并启动下载的函数
function checkDownloadQueue(): void {
  // 只有在有下载列表数据时才检查
  if (downloadList.value.length > 0) {
    // 查找第一个状态为 'waiting' 的插件
    const nextPlugin = downloadList.value.find((plugin) => plugin.status === 'waiting')
    if (nextPlugin && !installingPlugin.value) {
      downloadPlugin(nextPlugin)
    }
  }
}

// 启动下载队列检查定时器
function startDownloadQueueTimer(): void {
  if (downloadQueueTimer) {
    clearInterval(downloadQueueTimer)
  }
  // 每1秒检查一次下载队列
  downloadQueueTimer = window.setInterval(checkDownloadQueue, 1000)
}

// 停止下载队列检查定时器
function stopDownloadQueueTimer(): void {
  if (downloadQueueTimer) {
    clearInterval(downloadQueueTimer)
    downloadQueueTimer = null
  }
}

function openPluginDetail(plugin: Plugin): void {
  selectedPlugin.value = plugin
  isDetailVisible.value = true
}

function closePluginDetail(): void {
  isDetailVisible.value = false
  selectedPlugin.value = null
}

function openCategoryDetail(categorySummary: CategorySummary): void {
  const category = storefrontCategories.value[categorySummary.key]
  if (category) {
    selectedCategory.value = category
    isCategoryDetailVisible.value = true
  }
}

function closeCategoryDetail(): void {
  isCategoryDetailVisible.value = false
  selectedCategory.value = null
}

async function handleOpenPlugin(plugin: Plugin): Promise<void> {
  if (!plugin.path) {
    error('无法打开插件: 路径未知')
    return
  }
  try {
    const result = await window.ztools.internal.launch({
      path: plugin.path,
      type: 'plugin',
      name: plugin.title || plugin.name,
      param: {}
    })

    if (result && !result.success) {
      error(`无法打开插件: ${result.error || '未知错误'}`)
    }
  } catch (err: unknown) {
    console.error('打开插件失败:', err)
    error(`打开插件失败: ${err instanceof Error ? err.message : '未知错误'}`)
  }
}

function canUpgrade(plugin: Plugin): boolean {
  if (!plugin.installed || !plugin.localVersion || !plugin.version) return false
  return compareVersions(plugin.localVersion, plugin.version) < 0
}

async function handleUpgradePlugin(plugin: Plugin): Promise<void> {
  if (installingPlugin.value) return
  if (!plugin.path) {
    error('无法升级：找不到插件路径')
    return
  }

  const confirmUpgrade = await confirm({
    title: '升级插件',
    message: `发现新版本 ${plugin.version}，当前版本 ${plugin.localVersion}，是否升级？\n\n升级将先卸载旧版本。`,
    type: 'warning',
    confirmText: '升级',
    cancelText: '取消'
  })
  if (!confirmUpgrade) return

  installingPlugin.value = plugin.name
  try {
    const upgradeResult = await upgradeInstalledPluginFromMarket(
      { name: plugin.name, path: plugin.path },
      plugin
    )
    if (upgradeResult.success) {
      plugin.installed = true
      plugin.localVersion = plugin.version
      if (upgradeResult.plugin && upgradeResult.plugin.path) {
        plugin.path = upgradeResult.plugin.path
      }
      await fetchPlugins()
    } else {
      throw new Error(upgradeResult.error || '升级失败')
    }
  } catch (err: unknown) {
    console.error('升级出错:', err)
    error(`升级出错: ${err instanceof Error ? err.message : '未知错误'}`)
    await fetchPlugins()
  } finally {
    installingPlugin.value = null
  }
}

// 将插件加入待安装列表（仅 UI 状态，实际安装在 downloadPlugin 中处理）
async function addPlugin2DownList(plugin: Plugin): Promise<void> {
  let downList = db.get('downList')
  let list: Plugin[] = []
  if (!downList) {
    downList = {
      _id: 'downList',
      list: JSON.stringify(list)
    }
  } else {
    list = JSON.parse(downList.list) as Plugin[]
  }
  const exists = list.some((p) => p.name === plugin.name)
  if (!exists) {
    plugin.status = 'waiting'
    plugin.progress = 0
    list.push(plugin)
    downList.list = JSON.stringify(list)
    db.put(downList)
  } else {
    //todo 如果已存在，且之前下载失败了，这次重新加入下载，状态改为等待中
    list = list.map((p) => {
      if (p.name === plugin.name) {
        return { ...p, status: 'waiting' }
      }
      return p
    })
    downList.list = JSON.stringify(list)
    db.put(downList)
  }
  downloadList.value = list
  success(`插件 ${plugin.title} 已加入下载列表`)
}

async function downloadPlugin(plugin: Plugin): Promise<void> {
  if (installingPlugin.value) return

  installingPlugin.value = plugin.name
  try {
    updatePluginStatusInDb(plugin.name, 'downloading')
    const result = await window.ztools.internal.installPluginFromMarket(
      JSON.parse(JSON.stringify(plugin))
    )
    if (result.success) {
      plugin.installed = true
      plugin.localVersion = plugin.version
      updatePluginStatusInDb(plugin.name, 'installed', 100)
      if (result.plugin && result.plugin.path) {
        plugin.path = result.plugin.path
      }
    } else {
      updatePluginStatusInDb(plugin.name, 'failed', 0)
      console.error('插件安装失败:', result.error)
      error(`安装失败: ${result.error}`)
    }
  } catch (err: unknown) {
    updatePluginStatusInDb(plugin.name, 'failed', 0)
    console.error('安装出错:', err)
    error(`安装出错: ${err instanceof Error ? err.message : '未知错误'}`)
  } finally {
    installingPlugin.value = null
  }
}

async function handleUninstallPlugin(plugin: Plugin): Promise<void> {
  if (!plugin.path) {
    error('无法卸载：找不到插件路径')
    return
  }

  try {
    const deleteResult = await window.ztools.internal.deletePlugin(plugin.path)
    if (!deleteResult.success) {
      error(`卸载失败: ${deleteResult.error}`)
      return
    }

    success('插件卸载成功')

    plugin.installed = false
    plugin.localVersion = undefined
    plugin.path = undefined

    closePluginDetail()
    await fetchPlugins()
  } catch (err: unknown) {
    console.error('卸载出错:', err)
    error(`卸载出错: ${err instanceof Error ? err.message : '未知错误'}`)
  }
}

function handleBannerClick(item: BannerItem): void {
  if (item.url) {
    window.ztools.shellOpenExternal(item.url)
  }
}

function shuffleRandomSection(section: StorefrontSection): void {
  if (section.type !== 'random' || !section.plugins) return
  const allPlugins = plugins.value
  const usedNames = new Set<string>()

  // 收集其他区块已使用的插件名
  for (const s of storefrontSections.value) {
    if (s === section || s.type === 'banner' || s.type === 'navigation') continue
    for (const p of s.plugins || []) {
      usedNames.add(p.name)
    }
  }

  // 首页各区块互斥，从未被其他区块使用的插件中随机选取，避免重复展示
  const available = allPlugins.filter((p) => !usedNames.has(p.name))
  const count = section.plugins.length
  section.plugins = shuffleArray(available).slice(0, count)
}

// 处理 ESC 按键 - 逐级返回
function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (isDetailVisible.value) {
      e.stopPropagation()
      closePluginDetail()
    } else if (isCategoryDetailVisible.value) {
      e.stopPropagation()
      closeCategoryDetail()
    }
  }
}

// 获取分类的布局配置
function getCategoryLayout(categoryKey: string): CategoryLayoutSection[] {
  return categoryLayouts.value[categoryKey] || categoryLayouts.value['default'] || []
}

useJumpFunction<PluginMarketSettingJumpFunction>((state) => {
  if (state.payload && state.type === 'over') {
    setSubInput(state.payload)
  }
})

watch(activeTab, (tab) => {
  if (tab === 'download') {
    loadDownloadList()
  }
})

onMounted(() => {
  fetchPlugins()
  loadDownloadList()
  // 启动下载队列检查定时器
  startDownloadQueueTimer()
  window.addEventListener('keydown', handleKeydown, true)
})

onUnmounted(() => {
  // 停止下载队列检查定时器
  stopDownloadQueueTimer()
  window.removeEventListener('keydown', handleKeydown, true)
})
</script>
<template>
  <div class="plugin-market">
    <!-- 可滚动内容区 -->
    <div v-show="showScrollableContent" class="tab-header">
      <div class="tab-group">
        <button
          :class="['tab-btn', { active: activeTab === 'market' }]"
          @click="activeTab = 'market'"
        >
          插件商店
        </button>
        <button
          :class="['tab-btn', { active: activeTab === 'download' }]"
          @click="activeTab = 'download'"
        >
          下载列表
        </button>
      </div>
    </div>
    <Transition name="list-slide">
      <div v-show="showScrollableContent && activeTab === 'market'" class="scrollable-content">
        <div v-if="isLoading" class="loading-state">
          <div class="loading-spinner"></div>
          <span>加载中...</span>
        </div>

        <!-- 搜索模式：扁平网格 -->
        <template v-else-if="isSearchMode">
          <div v-if="filteredPlugins.length === 0" class="empty-state">
            <svg
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
              <path
                d="M16 16L20 20"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
            <span>未找到匹配的插件</span>
          </div>
          <div v-else class="market-grid">
            <PluginCard
              v-for="plugin in filteredPlugins"
              :key="plugin.name"
              :plugin="plugin"
              :installing-plugin="installingPlugin"
              :can-upgrade="canUpgrade(plugin)"
              @click="openPluginDetail(plugin)"
              @open="handleOpenPlugin(plugin)"
              @download="addPlugin2DownList(plugin)"
              @upgrade="handleUpgradePlugin(plugin)"
            />
          </div>
        </template>

        <!-- 首页模式：storefront 布局 -->
        <template v-else-if="hasStorefront">
          <div class="storefront">
            <template v-for="section in storefrontSections" :key="section.key">
              <!-- Banner 区块 -->
              <div v-if="section.type === 'banner'" class="storefront-banner">
                <div
                  v-for="(item, idx) in section.items"
                  :key="idx"
                  class="banner-item"
                  :class="{ clickable: !!item.url }"
                  :style="section.height ? { height: `${section.height}px` } : undefined"
                  @click="handleBannerClick(item)"
                >
                  <img :src="item.image" alt="" class="banner-image" draggable="false" />
                </div>
              </div>

              <!-- 分类导航区块 -->
              <div v-else-if="section.type === 'navigation'" class="storefront-section">
                <div v-if="section.title" class="section-header">
                  <span class="storefront-title">{{ section.title }}</span>
                </div>
                <div class="navigation-grid">
                  <CategoryCard
                    v-for="cat in section.categories"
                    :key="cat.key"
                    :title="cat.title"
                    :description="cat.description"
                    :icon="cat.icon"
                    :show-description="cat.showDescription"
                    :plugin-count="cat.pluginCount"
                    @click="openCategoryDetail(cat)"
                  />
                </div>
              </div>

              <!-- Fixed / Random 区块 -->
              <div
                v-else-if="section.type === 'fixed' || section.type === 'random'"
                class="storefront-section"
              >
                <div v-if="section.title || section.type === 'random'" class="section-header">
                  <span v-if="section.title" class="storefront-title">{{ section.title }}</span>
                  <RefreshButton
                    v-if="section.type === 'random'"
                    @click="shuffleRandomSection(section)"
                  />
                </div>
                <div class="market-grid">
                  <PluginCard
                    v-for="plugin in section.plugins"
                    :key="plugin.name"
                    :plugin="plugin"
                    :installing-plugin="installingPlugin"
                    :can-upgrade="canUpgrade(plugin)"
                    @click="openPluginDetail(plugin)"
                    @open="handleOpenPlugin(plugin)"
                    @download="addPlugin2DownList(plugin)"
                    @upgrade="handleUpgradePlugin(plugin)"
                  />
                </div>
              </div>
            </template>
          </div>
        </template>

        <!-- 降级模式：无 storefront 时平铺展示 -->
        <template v-else>
          <div v-if="plugins.length === 0" class="empty-state">
            <svg
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
              <path
                d="M16 16L20 20"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
            <span>暂无插件</span>
          </div>
          <div v-else class="market-grid">
            <PluginCard
              v-for="plugin in plugins"
              :key="plugin.name"
              :plugin="plugin"
              :installing-plugin="installingPlugin"
              :can-upgrade="canUpgrade(plugin)"
              @click="openPluginDetail(plugin)"
              @open="handleOpenPlugin(plugin)"
              @download="addPlugin2DownList(plugin)"
              @upgrade="handleUpgradePlugin(plugin)"
            />
          </div>
        </template>
      </div>
    </Transition>

    <Transition name="list-slide">
      <div v-show="showScrollableContent && activeTab === 'download'" class="scrollable-content">
        <template v-if="downloadList">
          <div v-if="downloadList.length === 0" class="empty-state">
            <svg
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
              <path
                d="M16 16L20 20"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
            <span>暂无下载列表</span>
          </div>
          <div v-else class="download-list">
            <div
              v-for="plugin in downloadList"
              :key="plugin.name"
              class="download-item"
              @click="openPluginDetail(plugin)"
            >
              <div class="download-item-content">
                <div class="download-item-icon">
                  <AdaptiveIcon
                    :src="plugin.logo ?? ''"
                    class="download-item-logo"
                    alt="icon"
                    draggable="false"
                  />
                </div>
                <div class="download-item-info">
                  <div class="download-item-name">{{ plugin.title || plugin.name }}</div>
                  <div class="download-item-description">{{ plugin.description }}</div>
                </div>
              </div>

              <!-- 状态显示区域 -->
              <div class="download-item-status">
                <!-- waiting 状态 -->
                <template v-if="plugin.status === 'waiting'">
                  <span :class="`status-text status-waiting`"> 等待中 </span>
                </template>

                <!-- downloading 状态 -->
                <template v-else-if="plugin.status === 'downloading'">
                  <div class="progress-container">
                    <div class="progress-bar">
                      <div class="progress-fill" :style="{ width: `${plugin.progress}%` }"></div>
                    </div>
                    <span class="progress-text">{{ Math.round(plugin.progress) }}%</span>
                  </div>
                </template>

                <!-- installed 状态 -->
                <template v-else-if="plugin.status === 'downloaded'">
                  <div v-if="plugin.installed" class="installed-container">
                    <span :class="`status-text status-installed`"> 已下载完成 </span>
                  </div>
                </template>
                <!-- installed 状态 -->
                <template v-else-if="plugin.status === 'installed'">
                  <div v-if="plugin.installed" class="installed-container">
                    <span :class="`status-text status-installed`"> ✓ 已安装 </span>
                  </div>
                </template>

                <!-- failed 状态 -->
                <template
                  v-if="
                    plugin.status === 'failed' ||
                    (plugin.status === 'installed' && !plugin.installed)
                  "
                >
                  <div class="failed-container">
                    <div class="failed-info">
                      <span :class="`status-text status-failed`"> 失败或已卸载 </span>
                      <span v-if="plugin.errorMessage" class="error-msg">{{
                        plugin.errorMessage
                      }}</span>
                    </div>
                    <div class="btn-group">
                      <button
                        class="btn-action btn-retry"
                        title="重试"
                        @click.stop="retryFailedDownload(plugin.name)"
                      >
                        🔄
                      </button>
                      <button
                        class="btn-action btn-delete"
                        title="删除"
                        @click.stop="removeFromDownloadList(plugin.name)"
                      >
                        🗑
                      </button>
                    </div>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </template>
      </div>
    </Transition>

    <!-- 分类详情覆盖面板 -->
    <Transition name="slide">
      <div
        v-if="isCategoryDetailVisible && selectedCategory"
        class="category-panel-container"
        :class="{ 'shifted-left': isDetailVisible }"
      >
        <CategoryDetail
          :category="selectedCategory"
          :layout="getCategoryLayout(selectedCategory.key)"
          :installing-plugin="installingPlugin"
          :plugin-map="pluginMap"
          :can-upgrade="canUpgrade"
          @back="closeCategoryDetail"
          @click-plugin="openPluginDetail"
          @open-plugin="handleOpenPlugin"
          @download-plugin="addPlugin2DownList"
          @upgrade-plugin="handleUpgradePlugin"
        />
      </div>
    </Transition>

    <!-- 插件详情覆盖面板组件 -->
    <Transition name="slide">
      <PluginDetail
        v-if="isDetailVisible && selectedPlugin"
        :plugin="selectedPlugin"
        :is-loading="installingPlugin === selectedPlugin.name"
        @back="closePluginDetail"
        @open="handleOpenPlugin(selectedPlugin)"
        @download="addPlugin2DownList(selectedPlugin)"
        @upgrade="handleUpgradePlugin(selectedPlugin)"
        @uninstall="handleUninstallPlugin(selectedPlugin)"
      />
    </Transition>
  </div>
</template>

<style scoped>
.plugin-market {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 可滚动内容区 */
.scrollable-content {
  position: absolute;
  top: 60px;
  left: 0;
  right: 0;
  bottom: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 20px;
  background: var(--bg-color);
}

/* 列表滑动动画 */
.list-slide-enter-active {
  transition:
    transform 0.2s ease-out,
    opacity 0.15s ease;
}

.list-slide-leave-active {
  transition:
    transform 0.2s ease-in,
    opacity 0.15s ease;
}

.list-slide-enter-from {
  transform: translateX(-100%);
  opacity: 0;
}

.list-slide-enter-to {
  transform: translateX(0);
  opacity: 1;
}

.list-slide-leave-from {
  transform: translateX(0);
  opacity: 1;
}

.list-slide-leave-to {
  transform: translateX(-100%);
  opacity: 0;
}

/* Storefront 布局 */
.storefront {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* Banner */
.storefront-banner {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.banner-item {
  border-radius: 12px;
  overflow: hidden;
  display: flex;
  align-items: center;
}

.banner-item.clickable {
  cursor: pointer;
}
.banner-item.clickable:hover {
  opacity: 0.92;
}
.banner-image {
  width: 100%;
  height: 100%;
  display: block;
  border-radius: 12px;
  object-fit: cover;
}

/* Section 通用 */
.storefront-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px;
}

.storefront-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-color);
}

/* 分类详情容器（支持左移动画） */
.category-panel-container {
  position: absolute;
  inset: 0;
  z-index: 10;
  background: var(--bg-color);
  transition: transform 0.2s ease-out;
}

.category-panel-container.shifted-left {
  transform: translateX(-100%);
}

/* 分类导航网格 */
.navigation-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

/* 插件网格 */
.market-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  gap: 12px;
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--divider-color);
  border-top-color: var(--primary-color);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.loading-state span {
  font-size: 13px;
  color: var(--text-color-secondary);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  gap: 12px;
  color: var(--text-secondary);
}

.empty-state svg {
  opacity: 0.4;
}

.empty-state span {
  font-size: 13px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* 下载列表项 */
.download-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  border: 1px solid var(--divider-color);
  border-radius: 6px;
  margin-bottom: 8px;
  transition: all 0.2s;
}

.download-item:hover {
  background: var(--hover-bg);
  border-color: var(--primary-color);
}

.download-item-content {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  cursor: pointer;
}

.download-item-icon {
  flex-shrink: 0;
  margin-right: 12px;
}

.download-item-logo {
  width: 48px;
  height: 48px;
  border-radius: 6px;
  object-fit: cover;
}

.download-item-info {
  flex: 1;
  min-width: 0;
}

.download-item-name {
  font-weight: 500;
  font-size: 14px;
  color: var(--text-primary);
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.download-item-description {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.download-item-status {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  margin-left: 12px;
}

.status-text {
  font-size: 12px;
  font-weight: 500;
  padding: 4px 8px;
  border-radius: 4px;
  white-space: nowrap;
  display: inline-block;
}

.status-waiting {
  color: var(--warning-color, #f59e0b);
  background: rgba(245, 158, 11, 0.1);
}

.status-downloading {
  color: var(--primary-color, #3b82f6);
  background: rgba(59, 130, 246, 0.1);
}

.status-installed {
  color: var(--success-color, #10b981);
  background: rgba(16, 185, 129, 0.1);
}

.status-failed {
  color: var(--error-color, #ef4444);
  background: rgba(239, 68, 68, 0.1);
}

.progress-container {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 100px;
}

.progress-bar {
  width: 80px;
  height: 4px;
  background: var(--bg-secondary, #f0f0f0);
  border-radius: 2px;
  overflow: hidden;
  flex-shrink: 0;
}

.progress-fill {
  height: 100%;
  background: var(--primary-color, #3b82f6);
  transition: width 0.3s ease;
}

.progress-text {
  font-size: 11px;
  color: var(--text-secondary);
  font-weight: 500;
  min-width: 28px;
  text-align: right;
}

.failed-container {
  display: flex;
  align-items: center;
  gap: 8px;
}

.failed-info {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}

.error-msg {
  font-size: 11px;
  color: var(--error-color, #ef4444);
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.btn-group {
  display: flex;
  gap: 4px;
}

.btn-action {
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--divider-color);
  background: var(--bg-color);
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  transition: all 0.2s;
  flex-shrink: 0;
}

.btn-action:hover {
  background: var(--hover-bg);
  border-color: var(--primary-color);
}

.btn-retry {
  color: var(--primary-color, #3b82f6);
}

.btn-delete {
  color: var(--error-color, #ef4444);
}

.tab-header {
  position: sticky;
  top: 0;
  left: 0;
  right: 0;
  gap: 8px;
  padding: 12px 20px;
  background: var(--bg-color);
  z-index: 5;
}

.tab-group {
  display: flex;
  gap: 6px;
  background: var(--control-bg);
  padding: 3px;
  border-radius: 8px;
}

.tab-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  justify-content: center;
  padding: 6px 14px;
  font-size: 13px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  font-weight: 500;
}

.tab-btn:hover {
  background: var(--hover-bg);
  color: var(--text-color);
}

.tab-btn.active {
  background: var(--active-bg);
  color: var(--primary-color);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}
</style>
