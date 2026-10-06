package com.sentrifugo.db.mapper;

import com.sentrifugo.db.dto.PmsCycleStageDTO;
import com.sentrifugo.db.entity.PmsCycleStageEntity;
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
public interface PmsCycleStageMapper {

    // Parent / referenced entities are resolved and attached by the service, never taken from the DTO.
    @Mapping(target = "cycle", ignore = true)
    PmsCycleStageEntity toEntity(PmsCycleStageDTO dto);

    @Mapping(source = "cycle.id", target = "cycleId")
    PmsCycleStageDTO toDTO(PmsCycleStageEntity entity);

    List<PmsCycleStageEntity> toEntityList(List<PmsCycleStageDTO> dtoList);

    List<PmsCycleStageDTO> toDTOList(List<PmsCycleStageEntity> entityList);

    @Mapping(target = "id", ignore = true)
    @Mapping(target = "cycle", ignore = true)
    void updateEntityFromDto(PmsCycleStageDTO dto, @MappingTarget PmsCycleStageEntity entity);
}
