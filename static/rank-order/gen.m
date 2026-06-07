% ====================== 配置参数 ======================
filePath = 'history.txt';  % 历史文件路径
numRange = 1:13;          % 生成 1-13 的随机排列
% ======================================================

%% 1. 读取并解析历史文件中的所有排列
fprintf('正在读取历史文件：%s...\n', filePath);
historyPerms = [];  % 存储所有有效历史排列

% 打开文件（只读模式）
fid = fopen(filePath, 'r');
if fid == -1
    error('错误：无法打开文件 %s，请检查文件路径！', filePath);
end

% 逐行读取文件
while ~feof(fid)
    line = fgetl(fid);  % 读取一行
    if isempty(line) || ~contains(line, ':')
        continue;  % 跳过空行和无冒号的无效行
    end
    
    % 分割字符串，提取冒号后的数字部分
    strParts = split(line, ':');
    numStr = strParts{2};       % 获取数字字符串
    nums = str2num(numStr);     % 转换为数字数组
    
    % 只保留长度为13、且是1-13的有效排列
    if length(nums) == 13 && all(ismember(nums, numRange)) && length(unique(nums)) == 13
        historyPerms = [historyPerms; nums];
    end
end
fclose(fid);  % 关闭文件

%% 2. 输出历史有效排列数量
fprintf('成功解析 %d 个有效历史排列\n', size(historyPerms, 1));

%% 3. 生成全新的随机排列（排除历史记录）
fprintf('正在生成新的随机排列...\n');
newPerm = [];
while true
    % 生成 1-13 的随机全排列
    newPerm = randperm(13);
    
    % 检查是否在历史记录中，不在则跳出循环
    if ~ismember(newPerm, historyPerms, 'rows')
        break;
    end
end

%% 4. 显示结果
fprintf('\n===== 生成成功！=====\n');
fprintf('新的随机排列：');
fprintf('%d ', newPerm);
fprintf('\n=====================\n');

%% 5. 追加写入历史文件（可选，注释掉可取消写入）
fprintf('正在将新排列追加写入历史文件...\n');
currentDate = datestr(now, 'mm/dd');  % 获取当前日期 月/日
newLine = sprintf('- %s: ', currentDate);
for i=1:length(newPerm)
    newLine = newLine + sprintf("%2d ",newPerm(i));
end
newLine = newLine + "\n";
% 追加写入文件
fid = fopen(filePath, 'a');
fprintf(fid, newLine);
fclose(fid);
fprintf('写入完成！\n');