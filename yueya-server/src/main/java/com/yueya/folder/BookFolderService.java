package com.yueya.folder;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.yueya.common.BizException;
import com.yueya.folder.entity.BookFolder;
import com.yueya.folder.mapper.BookFolderMapper;
import com.yueya.project.entity.BookProject;
import com.yueya.project.mapper.BookProjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

@Service
@RequiredArgsConstructor
public class BookFolderService {

    private final BookFolderMapper folderMapper;
    private final BookProjectMapper projectMapper;

    /** 返回用户全部文件夹（扁平），前端据 parentId 组树和面包屑。 */
    public List<BookFolder> listAll(Long userId) {
        return folderMapper.selectList(Wrappers.<BookFolder>lambdaQuery()
                .eq(BookFolder::getUserId, userId)
                .orderByAsc(BookFolder::getName));
    }

    public BookFolder create(Long userId, String name, Long parentId) {
        if (parentId != null) {
            requireOwned(userId, parentId);
        }
        BookFolder folder = new BookFolder();
        folder.setUserId(userId);
        folder.setParentId(parentId);
        folder.setName(name.trim());
        folderMapper.insert(folder);
        return folder;
    }

    public BookFolder rename(Long userId, Long id, String name) {
        BookFolder folder = requireOwned(userId, id);
        folder.setName(name.trim());
        folderMapper.updateById(folder);
        return folder;
    }

    /** 移动文件夹；targetParentId 为 null 表示移到根目录。禁止移入自身或子孙目录。 */
    public void move(Long userId, Long id, Long targetParentId) {
        requireOwned(userId, id);
        if (targetParentId != null) {
            requireOwned(userId, targetParentId);
            Map<Long, Long> parentOf = new HashMap<>();
            listAll(userId).forEach(f -> parentOf.put(f.getId(), f.getParentId()));
            for (Long cur = targetParentId; cur != null; cur = parentOf.get(cur)) {
                if (Objects.equals(cur, id)) {
                    throw new BizException("不能移动到自身或子文件夹中");
                }
            }
        }
        folderMapper.update(Wrappers.<BookFolder>lambdaUpdate()
                .eq(BookFolder::getId, id)
                .set(BookFolder::getParentId, targetParentId));
    }

    /** 删除文件夹：其中的项目和子文件夹上移到被删文件夹的父级。 */
    @Transactional
    public void delete(Long userId, Long id) {
        BookFolder folder = requireOwned(userId, id);
        Long parent = folder.getParentId();
        projectMapper.update(Wrappers.<BookProject>lambdaUpdate()
                .eq(BookProject::getUserId, userId)
                .eq(BookProject::getFolderId, id)
                .set(BookProject::getFolderId, parent));
        folderMapper.update(Wrappers.<BookFolder>lambdaUpdate()
                .eq(BookFolder::getUserId, userId)
                .eq(BookFolder::getParentId, id)
                .set(BookFolder::getParentId, parent));
        folderMapper.deleteById(id);
    }

    public BookFolder requireOwned(Long userId, Long id) {
        BookFolder folder = folderMapper.selectById(id);
        if (folder == null || !folder.getUserId().equals(userId)) {
            throw BizException.notFound("文件夹");
        }
        return folder;
    }
}
