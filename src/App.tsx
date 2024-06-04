import ImageList from '@mui/material/ImageList'
import ImageListItem from '@mui/material/ImageListItem'
import { message } from '@tauri-apps/api/dialog'
import {
  readDir,
  exists,
  createDir,
  readTextFile,
  writeBinaryFile,
  copyFile,
  BaseDirectory
} from '@tauri-apps/api/fs'
import { getClient, ResponseType } from '@tauri-apps/api/http'
import { homeDir, downloadDir } from '@tauri-apps/api/path'
import { Command } from '@tauri-apps/api/shell'
import { useState } from 'react'
import { PhotoProvider, PhotoView } from 'react-photo-view'
import xmlJs from 'xml-js'
import { sleep } from './utils/timer'
import { getUrlParam } from './utils/url'
import './App.css'

interface IMaybeUrl {
  _text: string
  src: string
}

interface ISelectOption {
  label: string
  value: string
}

function App() {
  // weChat 目录路径
  const weChatDirPath =
    'Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/2.0b4.0.9'
  // 下载图片的列表
  const [downloadImgList, setDownloadImgList] = useState<Array<IMaybeUrl>>([])
  // 页面展示图片的列表
  const [showImgList, setShowImgList] = useState<Array<IMaybeUrl>>([])
  // 下载的子目录集合
  const [downloadSubDirs, setDownloadSubDirs] = useState<Array<number>>([])
  // 导出进度数
  const [exportProgress, setExportProgress] = useState(0)
  // 是否正在导出
  const [isExporting, setIsExporting] = useState(false)
  // home 目录路径
  const [homeDirPath, setHomeDirPath] = useState('')
  // download 目录路径
  const [downloadDirPath, setDownloadDirPath] = useState('')
  // 自定义表情包的目录名 - 用于最终存储
  const [customEmotionsDirName, setCustomEmotionsDirName] = useState('')
  // 目标目录名称集合
  const [targetDirNames, setTargetDirNames] = useState<Array<ISelectOption>>([])
  // 选择的表情包文件夹
  const [selectedTargetDir, setSelectedTargetDir] = useState('')

  async function getFsPermission() {
    setHomeDirPath(await homeDir())
    setDownloadDirPath(await downloadDir())

    // weChat 目录下的文件夹
    const weChatDirs = await readDir(weChatDirPath, {
      dir: BaseDirectory.Home,
      recursive: false
    })
    // 过滤非 32 位长度的文件夹，即可能是目标文件夹
    const maybeTargetDirs = weChatDirs.filter((dir) => {
      return dir?.name?.length === 32
    })

    // 符合条件的表情包文件夹
    const targetDirs: Array<string> = []
    // 找到存有 fav.archive 文件夹
    for (let i = 0; i < maybeTargetDirs.length; i++) {
      const file = maybeTargetDirs[i]
      const stickerFile = `${weChatDirPath}/${file.name}/Stickers/fav.archive`
      // 判定该文件夹是否存在 fav.archive 文件
      const stickerExists = await exists(stickerFile, {
        dir: BaseDirectory.Home
      })
      // 找到目标文件夹 - 目录名
      if (stickerExists && file.name) {
        targetDirs.push(file.name)
      }
    }

    if (!targetDirs.length) {
      return await message('没找到表情包存储目录，要不换个电脑吧🧐', {
        title: '骚瑞',
        type: 'error'
      })
    }
    targetDirs.unshift('')
    setTargetDirNames(
      targetDirs.map((name) => {
        return {
          label: name || '请选择',
          value: name
        }
      })
    )

    // 拷贝 fav.archive 文件到 fav.archive.plist
    for (let i = 0; i < targetDirs.length; i++) {
      const targetDirName = targetDirs[i]
      if (targetDirName) {
        const stickersPath = `${weChatDirPath}/${targetDirName}/Stickers`
        const sourcePath = `${stickersPath}/fav.archive`
        const destinationPath = `${stickersPath}/fav.archive.plist`
        await copyFile(sourcePath, destinationPath, { dir: BaseDirectory.Home })

        const cmd = new Command('plutil-file', [
          '-convert',
          'xml1',
          `${homeDirPath}/${destinationPath}`
        ])
        await cmd.execute()
      }
    }
  }

  async function selectChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const dirName = e.target.value

    setCustomEmotionsDirName(`微信表情包_导出_${dirName}`)
    setSelectedTargetDir(dirName)

    const stickersPath = `${weChatDirPath}/${dirName}/Stickers`
    const destinationPath = `${stickersPath}/fav.archive.plist`

    const cmd = new Command('plutil-file', [
      '-convert',
      'xml1',
      `${homeDirPath}/${destinationPath}`
    ])
    await cmd.execute()

    const plistData = await readTextFile(destinationPath, {
      dir: BaseDirectory.Home
    })

    const archiveData = xmlJs.xml2json(plistData, { compact: true, spaces: 4 })
    const maybeUrls = JSON.parse(archiveData).plist.dict.array.string
    const urls = maybeUrls
      .filter((item: IMaybeUrl) => {
        return String(item._text).match(/http[s]?:\/\/[^\s]+/)
      })
      .map((item: IMaybeUrl) => {
        return {
          src: item._text
        }
      })
    setShowImgList(urls)
    setDownloadImgList(urls.slice().reverse())
  }

  async function fetchImg(src: string): Promise<[boolean, ArrayBuffer]> {
    const client = await getClient()
    return new Promise((resolve) => {
      client
        .get(src, {
          responseType: ResponseType.Binary
        })
        .then((res) => {
          const buffer = res.data as ArrayBuffer
          return resolve([true, buffer])
        })
        .catch((err) => {
          return resolve([false, err])
        })
    })
  }

  async function parseWeChatArchive() {
    setIsExporting(true)
    setExportProgress(0)
    // 保存图片到本地
    await createDir(customEmotionsDirName, {
      dir: BaseDirectory.Download,
      recursive: true
    })

    // 获取 img 的 Uint8Array
    for (let i = 0; i < downloadImgList.length; i++) {
      // TODO: 限制下载数量 测试用
      // if (i > 10) {
      //   break
      // }

      const { src } = downloadImgList[i]
      const [isOk, imgBuffer] = await fetchImg(src)
      setExportProgress(i + 1)
      if (isOk) {
        await handleExport(src, i, imgBuffer)
        await sleep(100)
      }
    }
    // await message('完成咯～')
    await sleep(1500)
    setIsExporting(false)
    setExportProgress(0)
    openDir()
  }

  const handleDownload = async (
    dirPath: string,
    src: string,
    imgBuffer: ArrayBuffer
  ) => {
    const fileKey = getUrlParam(src, 'm')
    return await writeBinaryFile(
      `${dirPath}/${fileKey}.gif`,
      new Uint8Array(imgBuffer),
      { dir: BaseDirectory.Download }
    )
  }

  // 导出图片 - 50 个为一个目录
  async function handleExport(src: string, i: number, imgBuffer: ArrayBuffer) {
    const subDirNumber = Math.floor(i / 50)
    const subDirPath = `${customEmotionsDirName}/${subDirNumber * 50 + 1}_${(subDirNumber + 1) * 50}_组`
    if (downloadSubDirs.includes(subDirNumber)) {
      await handleDownload(subDirPath, src, imgBuffer)
    } else {
      setDownloadSubDirs([...downloadSubDirs, subDirNumber])
      await createDir(subDirPath, {
        dir: BaseDirectory.Download,
        recursive: true
      })
      await handleDownload(subDirPath, src, imgBuffer)
    }
  }

  // 打开下载目录
  async function openDir() {
    // const path = `${downloadDirPath}${customEmotionsDirName}`
    await new Command('open-dir', [downloadDirPath]).execute()
  }

  return (
    <div className="container">
      <button className="ml-20" onClick={getFsPermission}>
        查找微信表情包
      </button>

      <>
        {targetDirNames.length > 0 && (
          <div className="mt-20">
            <label>选择目标文件夹:</label>
            <select value={selectedTargetDir} onChange={selectChange}>
              {targetDirNames.map((item, index) => (
                <option key={index} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {targetDirNames.length > 0 && (
          <div>
            <div>我也不晓得哪个目录下的表情包是你的，自己选一个然后导出吧</div>
            {!!selectedTargetDir && (
              <>
                {isExporting ? (
                  <span>正在导出，请稍后...</span>
                ) : (
                  <button onClick={parseWeChatArchive}>
                    导出该微信目录下的表情包
                  </button>
                )}
                {exportProgress > 0 && exportProgress && (
                  <span className="ml-20">
                    导出进度：{exportProgress}/{showImgList.length}
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </>

      {showImgList.length ? (
        <h1>
          {showImgList.length}个表情包预览
          {showImgList.length > 30 ? `（仅显示前30个）` : ''}
        </h1>
      ) : (
        selectedTargetDir && <h1>啥也没有</h1>
      )}
      <div className="img-list">
        <ImageList cols={5}>
          <PhotoProvider>
            {showImgList.slice(0, 30).map((item, index) => (
              <ImageListItem key={item.src}>
                <div className="img-preview">
                  <PhotoView key={index} src={item.src}>
                    <img src={item.src} loading="lazy" alt="" />
                  </PhotoView>
                </div>
              </ImageListItem>
            ))}
          </PhotoProvider>
        </ImageList>
      </div>
    </div>
  )
}

export default App
