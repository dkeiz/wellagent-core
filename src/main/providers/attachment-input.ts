// @ts-nocheck
const fs = require('fs');

function imageAttachments(attachments = []) {
  return (Array.isArray(attachments) ? attachments : [])
    .filter(item => item?.type === 'image' && item.path && fs.existsSync(item.path));
}

function readImage(item) {
  const data = fs.readFileSync(item.path).toString('base64');
  const mimeType = String(item.mimeType || 'image/png');
  return { data, dataUri: `data:${mimeType};base64,${data}`, mimeType };
}

function replaceLastUser(messages, transform) {
  const result = messages.map(message => ({ ...message }));
  for (let index = result.length - 1; index >= 0; index -= 1) {
    if (result[index].role !== 'user') continue;
    result[index] = transform(result[index]);
    break;
  }
  return result;
}

function applyOpenAIImageInput(messages, attachments) {
  const images = imageAttachments(attachments);
  if (images.length === 0) return messages;
  return replaceLastUser(messages, message => {
    const content = Array.isArray(message.content)
      ? [...message.content]
      : [{ type: 'text', text: String(message.content || '') }];
    images.forEach(item => {
      content.push({ type: 'image_url', image_url: { url: readImage(item).dataUri } });
    });
    return { ...message, content };
  });
}

function applyAnthropicImageInput(messages, attachments) {
  const images = imageAttachments(attachments);
  if (images.length === 0) return messages;
  return replaceLastUser(messages, message => {
    const content = Array.isArray(message.content)
      ? [...message.content]
      : [{ type: 'text', text: String(message.content || '') }];
    images.forEach(item => {
      const image = readImage(item);
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mimeType, data: image.data }
      });
    });
    return { ...message, content };
  });
}

function applyOllamaImageInput(messages, attachments) {
  const images = imageAttachments(attachments);
  if (images.length === 0) return messages;
  return replaceLastUser(messages, message => ({
    ...message,
    images: images.map(item => readImage(item).data)
  }));
}

function applyDashScopeImageInput(messages, attachments) {
  const images = imageAttachments(attachments);
  if (images.length === 0) return messages;
  return replaceLastUser(messages, message => {
    const content = images.map(item => ({ image: readImage(item).dataUri }));
    content.push({ text: String(message.content || '') });
    return { ...message, content };
  });
}

module.exports = {
  applyAnthropicImageInput,
  applyDashScopeImageInput,
  applyOllamaImageInput,
  applyOpenAIImageInput,
  imageAttachments
};
