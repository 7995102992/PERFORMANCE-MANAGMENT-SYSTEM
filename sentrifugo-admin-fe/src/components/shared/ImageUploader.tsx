import * as React from 'react';
import { Upload, X } from 'lucide-react';
import ReactCrop, { type Crop, type PixelCrop, centerCrop, makeAspectCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface ImageUploaderProps {
  value?: File | string | null;
  onChange: (file: File | null) => void;
  maxSizeMB?: number;
  allowedTypes?: string[];
  className?: string;
  cropWidth?: number;
  cropHeight?: number;
}

function getCroppedImg(image: HTMLImageElement, crop: PixelCrop, fileName: string, targetWidth?: number, targetHeight?: number): Promise<File> {
  const canvas = document.createElement('canvas');
  const scaleX = image.naturalWidth / image.width;
  const scaleY = image.naturalHeight / image.height;
  canvas.width = targetWidth || crop.width;
  canvas.height = targetHeight || crop.height;
  const ctx = canvas.getContext('2d');

  if (!ctx) return Promise.reject(new Error('No 2d context'));

  ctx.drawImage(
    image,
    crop.x * scaleX,
    crop.y * scaleY,
    crop.width * scaleX,
    crop.height * scaleY,
    0,
    0,
    canvas.width,
    canvas.height
  );

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Canvas is empty'));
        return;
      }
      resolve(new File([blob], fileName, { type: 'image/jpeg' }));
    }, 'image/jpeg', 1);
  });
}

function centerAspectCrop(mediaWidth: number, mediaHeight: number, aspect: number) {
  return centerCrop(
    makeAspectCrop({ unit: '%', width: 90 }, aspect, mediaWidth, mediaHeight),
    mediaWidth,
    mediaHeight
  );
}

export function ImageUploader({
  value,
  onChange,
  maxSizeMB = 2,
  allowedTypes = ['image/jpeg', 'image/png', 'image/jpg'],
  className,
  cropWidth,
  cropHeight,
}: ImageUploaderProps) {
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  
  const [isCropModalOpen, setIsCropModalOpen] = React.useState(false);
  const [upImg, setUpImg] = React.useState<string>();
  const [tempFile, setTempFile] = React.useState<File | null>(null);
  const imgRef = React.useRef<HTMLImageElement>(null);
  const [crop, setCrop] = React.useState<Crop>();
  const [completedCrop, setCompletedCrop] = React.useState<PixelCrop>();

  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const aspect = cropWidth && cropHeight ? cropWidth / cropHeight : undefined;

  React.useEffect(() => {
    if (!value) {
      setPreviewUrl(null);
      return;
    }
    if (typeof value === 'string') {
      setPreviewUrl(value);
    } else if (value instanceof File) {
      const objectUrl = URL.createObjectURL(value);
      setPreviewUrl(objectUrl);
      return () => URL.revokeObjectURL(objectUrl);
    }
  }, [value]);

  const onSelectFile = (file: File) => {
    setError(null);
    if (!allowedTypes.includes(file.type)) {
      setError(`Invalid file type.`);
      return;
    }
    if (file.size > maxSizeMB * 1024 * 1024) {
      setError(`File is too large.`);
      return;
    }

    if (aspect) {
      setTempFile(file);
      const reader = new FileReader();
      reader.addEventListener('load', () => setUpImg(reader.result?.toString() || ''));
      reader.readAsDataURL(file);
      setIsCropModalOpen(true);
    } else {
      onChange(file);
    }

    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onSelectFile(e.target.files[0]);
    }
  };

  const onImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const { width, height } = e.currentTarget;
    if (aspect) {
      setCrop(centerAspectCrop(width, height, aspect));
    }
  };

  const handleSaveCrop = async () => {
    if (completedCrop && imgRef.current && tempFile) {
      try {
        const croppedFile = await getCroppedImg(imgRef.current, completedCrop, tempFile.name, cropWidth, cropHeight);
        onChange(croppedFile);
        setIsCropModalOpen(false);
      } catch (e) {
        console.error(e);
      }
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onSelectFile(e.dataTransfer.files[0]);
    }
  };

  return (
    <div className={cn('w-full', className)}>
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        accept={allowedTypes.join(',')}
        onChange={handleFileChange}
      />
      {!previewUrl ? (
        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          className="relative flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-lg cursor-pointer bg-muted/50 border-muted-foreground/25 hover:bg-muted"
        >
          <div className="flex flex-col items-center justify-center pt-5 pb-6">
            <Upload className="w-8 h-8 mb-3 text-muted-foreground" />
            <p className="mb-2 text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">Click to upload</span> or drag and drop
            </p>
            <p className="text-xs text-label uppercase">
              {allowedTypes.map(t => t.split('/')[1]).join(', ')} (MAX. {maxSizeMB}MB)
            </p>
            {cropWidth && cropHeight && (
              <p className="text-xs text-muted-foreground font-medium mt-1">
                Required dimensions: {cropWidth}x{cropHeight}px
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="relative w-fit mx-auto">
          <div
            className="rounded-lg border overflow-hidden bg-muted flex items-center justify-center bg-white"
            style={{
               width: cropWidth ? Math.min(cropWidth, 300) : 128,
               height: cropHeight ? Math.min(cropHeight, 175) : 128
            }}
          >
            <img src={previewUrl} alt="Preview" className="w-full h-full object-contain" />
          </div>
          <Button
            type="button"
            variant="destructive"
            size="icon"
            className="absolute -top-2 -right-2 h-6 w-6 rounded-full"
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-destructive text-center">{error}</p>}

      <Dialog open={isCropModalOpen} onOpenChange={setIsCropModalOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Crop Image</DialogTitle>
            <DialogDescription>
              Adjust your image to exactly match the {cropWidth}x{cropHeight} required dimensions.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-center items-center overflow-auto max-h-[60vh] p-4 bg-muted border rounded-md">
            {upImg && (
              <ReactCrop
                crop={crop}
                onChange={(c) => setCrop(c)}
                onComplete={(c) => setCompletedCrop(c)}
                aspect={aspect}
              >
                <img 
                  ref={imgRef}
                  alt="Crop preview" 
                  src={upImg} 
                  onLoad={onImageLoad} 
                  className="max-w-full"
                />
              </ReactCrop>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCropModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveCrop} disabled={!completedCrop?.width || !completedCrop?.height}>
              Save Crop
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
