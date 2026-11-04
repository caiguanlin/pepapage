package com.yueya.auth.convert;

import com.yueya.auth.dto.AuthDtos.UserInfo;
import com.yueya.common.convert.CentralMapperConfig;
import com.yueya.user.entity.User;
import org.mapstruct.Mapper;

@Mapper(config = CentralMapperConfig.class)
public interface UserConverter {

    UserInfo toInfo(User user);
}
