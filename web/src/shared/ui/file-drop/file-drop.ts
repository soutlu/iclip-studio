import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type RefObject,
} from 'react'

const hasDraggedFiles = (event: { dataTransfer: DataTransfer | null }): boolean =>
  event.dataTransfer?.types.includes('Files') === true

const isDirectory = (item: DataTransferItem | undefined): boolean =>
  item?.webkitGetAsEntry?.()?.isDirectory === true

export const filesWithoutDirectories = (dataTransfer: DataTransfer): File[] => {
  const items = [...dataTransfer.items]
  return [...dataTransfer.files].filter((_file, index) => !isDirectory(items[index]))
}

type FileDropTargetOptions = {
  blocked: boolean
  onFiles: (files: File[]) => void
  onDirectory: (files: File[]) => void
}

export const useFileDropTarget = ({ blocked, onFiles, onDirectory }: FileDropTargetOptions) => {
  const depthRef = useRef(0)
  const [over, setOver] = useState(false)
  const claim = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = blocked ? 'none' : 'copy'
  }
  const dragHandlers = {
    onDragEnter: (event: ReactDragEvent<HTMLElement>) => {
      if (!hasDraggedFiles(event)) return
      claim(event)
      depthRef.current += 1
      setOver(true)
    },
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      if (!hasDraggedFiles(event)) return
      claim(event)
    },
    onDragLeave: (event: ReactDragEvent<HTMLElement>) => {
      if (!hasDraggedFiles(event)) return
      depthRef.current = Math.max(0, depthRef.current - 1)
      if (depthRef.current === 0) setOver(false)
    },
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      if (!hasDraggedFiles(event)) return
      depthRef.current = 0
      setOver(false)
      if (event.defaultPrevented) return
      event.preventDefault()
      if (blocked) return
      if ([...event.dataTransfer.items].some((item) => isDirectory(item))) {
        onDirectory(filesWithoutDirectories(event.dataTransfer))
        return
      }
      onFiles([...event.dataTransfer.files])
    },
  }
  return { dragOver: over && !blocked, dragHandlers }
}

const refuseDraggedFiles = (event: ReactDragEvent<HTMLElement>) => {
  if (!hasDraggedFiles(event) || event.defaultPrevented) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'none'
}

export const refuseFileDropProps = {
  onDragEnter: refuseDraggedFiles,
  onDragOver: refuseDraggedFiles,
  onDrop: refuseDraggedFiles,
}

type WindowFileDropOptions = {
  enabled: boolean
  ownRef: RefObject<HTMLElement | null>
  onFiles: (files: File[]) => void
}

export const useWindowFileDrop = ({ enabled, ownRef, onFiles }: WindowFileDropOptions): boolean => {
  const [dragOver, setDragOver] = useState(false)
  const receive = useEffectEvent(onFiles)

  useEffect(() => {
    if (!enabled) return
    let depth = 0
    const claimedElsewhere = (event: DragEvent) =>
      event.defaultPrevented &&
      !(event.target instanceof Node && ownRef.current?.contains(event.target) === true)
    const onDragEnter = (event: DragEvent) => {
      if (!hasDraggedFiles(event)) return
      depth += 1
      setDragOver(!claimedElsewhere(event))
      if (!event.defaultPrevented) event.preventDefault()
    }
    const onDragOver = (event: DragEvent) => {
      if (!hasDraggedFiles(event)) return
      setDragOver(!claimedElsewhere(event))
      if (!event.defaultPrevented) event.preventDefault()
    }
    const onDragLeave = (event: DragEvent) => {
      if (!hasDraggedFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragOver(false)
    }
    const onDrop = (event: DragEvent) => {
      depth = 0
      setDragOver(false)
      if (event.defaultPrevented || event.dataTransfer === null || !hasDraggedFiles(event)) return
      event.preventDefault()
      const files = filesWithoutDirectories(event.dataTransfer)
      if (files.length > 0) receive(files)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [enabled, ownRef])

  return dragOver
}
