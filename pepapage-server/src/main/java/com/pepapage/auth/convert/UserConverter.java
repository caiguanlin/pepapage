package com.pepapage.auth.convert;

import com.pepapage.auth.dto.AuthDtos.UserInfo;
import com.pepapage.common.convert.CentralMapperConfig;
import com.pepapage.user.entity.User;
import org.mapstruct.Mapper;

@Mapper(config = CentralMapperConfig.class)
public interface UserConverter {

    UserInfo toInfo(User user);
}
