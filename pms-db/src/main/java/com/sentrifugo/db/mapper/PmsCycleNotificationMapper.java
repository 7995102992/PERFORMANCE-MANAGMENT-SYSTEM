package com.sentrifugo.db.mapper;

import com.sentrifugo.db.dto.PmsCycleNotificationDTO;
import com.sentrifugo.db.entity.PmsCycleNotificationEntity;
import org.mapstruct.Builder;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.MappingTarget;
import org.mapstruct.NullValuePropertyMappingStrategy;
import org.mapstruct.ReportingPolicy;

import java.util.List;

@Mapper(
        componentModel = "spring",
        unmappedTargetPolicy = ReportingPolicy.IGNORE,
        nullValuePropertyMappingStrategy = NullValuePropertyMappingStrategy.IGNORE,
        // Lombok @SuperBuilder entities/DTOs: map through constructor + setters (see PmsCycleMapper).
        builder = @Builder(disableBuilder = true)
)
public interface PmsCycleNotificationMapper {

    // Parent / referenced entities are resolved and attached by the service, never taken from the DTO.
    @Mapping(target = "cycle", ignore = true)
    PmsCycleNotificationEntity toEntity(PmsCycleNotificationDTO dto);

    @Mapping(source = "cycle.id", target = "cycleId")
    PmsCycleNotificationDTO toDTO(PmsCycleNotificationEntity entity);

    List<PmsCycleNotificationEntity> toEntityList(List<PmsCycleNotificationDTO> dtoList);

    List<PmsCycleNotificationDTO> toDTOList(List<PmsCycleNotificationEntity> entityList);

    @Mapping(target = "id", ignore = true)
    @Mapping(target = "cycle", ignore = true)
    void updateEntityFromDto(PmsCycleNotificationDTO dto, @MappingTarget PmsCycleNotificationEntity entity);
}
